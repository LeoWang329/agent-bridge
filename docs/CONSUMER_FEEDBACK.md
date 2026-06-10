# Agent Bridge — 消费方(编排者)反馈清单

> 视角:作为 MCP 的**消费方 / 编排方 agent**——通过 MCP 派活并收口后端 agent(omp/codex/…)。消费方**不绑定单一 agent**:现有 Claude Code、Codex(Codex 也可作 host),未来可能其它 agent,所以下列建议都按**任意编排方**来提,不假设某个具体 host。
> 依据:一次真实派活会话(open→send(非阻塞)→wait(mode:all)→close)的实际返回 + 通读 `skills/agent-bridge/SKILL.md`(v0.5.7)。
> 范围有限:只覆盖这次调到的 endpoint(open/send/wait/close);`result`/`status`/`doctor` 的 payload 未逐一核实。
> 整理 2026-06-07。

---

## P1 · `text` 过大时没有"罗盘针" 〔最高〕

- **现状**:返回整轮 assistant 全文 `text`,无 `textBytes`、无 `truncated` 标志、无指针。
- **问题**:`text` 是消费方**必读**的内容(不是可丢的日志),所以**不能简单截断**;但整段大产出(改代码、长文档)直接灌进上下文又有撑爆风险。现在这个两难只能靠经验/口头约定回避(SKILL 也只能口头建议"产物看 `git diff`")。
- **建议**:`text` 过大时**给一根罗盘针、而不是静默丢**——返回 `textBytes`/`charCount`,超阈值时置 `truncated:true` + `textRef`(指 `logFile`/artifact 文件)让消费方**按需取回全文**;可选 `maxChars` 入参自定上限。**核心:必读内容绝不静默丢失——要么给全,要么给可取回的指针。**

## P2 · 跨 endpoint 字段命名不统一 〔改动小、收益稳〕

- **现状**:同一份数据里 `session_id`(snake)与 `createdAt`/`logFile`(camel)混用;`wait` 结果给 `log_file`(snake),对应 `open` 的 `logFile`(camel)。
- **问题**:通用解析易踩;同一概念要写两种 key。
- **建议**:全 endpoint 统一一种命名规范,至少**同一字段全程同名**。

## P3 · session 形状随 agent 变 〔通用编排痛点〕

- **现状**:`omp` 的 open 返回带 `sessionState`;`codex` 带 `threadId`/`turnCount`。差异字段平铺在顶层。
- **问题**:写跨 agent 的通用编排得 special-case 每种后端。
- **建议**:**公共核心字段 + `agentSpecific:{}` 子对象**收纳后端差异,顶层 schema 稳定。

## P4 · `sessionState: null` 是未文档化的死字段 〔清理〕

- **现状**:`omp` open 返回里恒为 `null`,SKILL 与 payload 都没解释它是什么。
- **建议**:要么填有意义的内容(并文档化),要么移除。恒 null 的字段只让消费方犯嘀咕。

## P5 · 结果缺 turn 级时间戳 / 时长 〔几乎零成本〕

- **现状**:`wait` 每条结果只有 `session_id`/`status`/`text`/`log_file`,**无** `startedAt`/`endedAt`/`durationMs`。
- **问题**:消费方做 run-log / profiling 拿不到耗时——而桥内部本就知道。
- **建议**:每条结果带 turn 级 `startedAt`/`endedAt`/`durationMs`。

## P6 · 无 turn id,`wait` 只能 join 会话、不能 join 某一轮 〔低优先〕

- **现状**:`send` 的 ack 无 `turnId`;`wait` 等的是"会话当前轮空闲"。
- **问题**:想精确 join "某一轮"(复杂流水线、同会话多轮)缺把手。
- **建议**:`send` 返回 `turnId`,`wait` 支持按 `turnId` join(可选)。

---

## 优先级一句话

> **P1(text 罗盘针)** 价值最高——它消掉"靠经验避爆上下文"这条隐性规则。其次 **P2/P4**(命名/死字段,改动极小的一致性收益),再到 **P5/P3**,**P6** 最后。

---

## 处理结果(v0.6.0,2026-06-07)

全部 6 条已实现并**对 omp + codex 各跑一遍 open→send(非阻塞)→wait→result→close 实测通过**(45/45 断言)。

| # | 状态 | 改动 |
|---|---|---|
| **P1** | ✅ | `result`/`wait`/`send(wait)` 结果**永远带** `charCount`/`byteCount`;完整未截断全文写入 artifact 并由 `textRef` 指向(`close` 时清理);新增入参 `max_chars`,超限时 `text` 截断 + `truncated:true`,而 `charCount` 仍报全长、`textRef` 仍是全文。**全文取自后端未截断原文,绕过内部 400k clamp,真正零静默丢失。** |
| **P2** | ✅ | 定约定:**入参 snake_case,出参一律 camelCase**。`log_file→logFile`、`recent_events→recentEvents`、`session_id→sessionId`、`timed_out→timedOut`、`text_delta→textDelta`、`sessions_closed→sessionsClosed`、`child_processes→childProcesses`;UI/SSE 消费端同步更新。 |
| **P3** | ✅ | `summary()` 收敛为**公共核心字段 + `agentSpecific:{}`**,顶层 schema 两后端完全一致(实测 open 返回 key 集相同)。 |
| **P4** | ✅ | 死字段 `sessionState:null` 移除;omp 的后端态归入 `agentSpecific`,首轮前为 `{}`,跑过一轮后填入有意义内容(sessionId/messageCount/model…)。 |
| **P5** | ✅ | 每轮记 `turnStartedAt`/`turnEndedAt`,经 `lastTurn:{id,startedAt,endedAt,durationMs}` 进 `session` 与 `wait` 结果。 |
| **P6** | ✅ | `send` ack 返回 `turnId`(codex 用后端 turn id,omp 桥内铸一个),与结果里 `lastTurn.id` 对得上。因单会话单活跃 turn,`wait` 按 session join 即等价该 turn;按 turnId 过滤的 join 暂不单独实现(已有 `turnId` 可供匹配/核对)。 |

> 这是 **破坏性 schema 变更**(出参 key 改名),已以 minor 版本 **0.5.7 → 0.6.0** 标记;SKILL.md 新增「返回结构与命名约定」一节,README 增 “Result shape (v0.6.0)”。

### 交叉审核(codex + deepseek-v4-pro)发现的边界问题已修

用 Agent Bridge 自身拉起 codex 与 deepseek 各做一遍独立审核,两方一致认可 P1–P6 已正确实现,并指出 4 个边界缺陷,均已修复:

1. **截断时 artifact 写失败会静默丢全文** → `buildSessionResult` 仅在 `textRef` 写成功时才截断,否则退化为返回完整 inline 文本,守住「必读内容绝不静默丢失」。
2. **后端进程中途崩溃不写 `turnEndedAt`**(OMP `proc.on(error/close)`、Codex `#rejectAll`)→ 崩溃时补盖结束时间,`durationMs` 不再恒 null。
3. **Codex `turn/start` 失败/超时留下错配的 `lastTurn`**(旧 id + 新 startedAt)→ 计时改到 `turn/start` 成功后才打,失败路径保留上一轮的完整 `lastTurn`;OMP 同理改到 prompt ack 之后再铸 turnId/打点。
4. **HTTP/UI facade 不透传 `max_chars`** → messages POST(body)与 result GET(query)补上,与 MCP/CLI 对齐。

复测:happy-path 端到端 omp+codex 各跑一遍 **22/22 通过**(含计时重排后 `lastTurn.id === ack.turnId`、`durationMs ≥ 0` 的断言)。

### 第二轮交叉审核 + `recentEvents` 降噪

再用 codex + deepseek 复审上面这批修复:两方一致 **7 项目标修复全部 PASS、无回归**,并确认「`status: running` 但 turn 已结束、文本只有 `.`」**不是桥的状态错乱,而是 agent 在一个 prompt 内跑多轮工具循环的实时真相**(`status` 是 live 探针,会主动 `get_state`;`turn_start` 会清空 `lastAssistantText`,所以会捕捉到「上一轮刚结束、下一轮才吐第一个字符」的瞬间)。要已结算结果请用 `wait`/`result`。又补 4 个边界:

- `abort()` 不再给已结束的 turn 续时长(只在确有在跑的 turn 时才盖 `turnEndedAt`);OMP `close()` 同步补盖,和 Codex 对齐。
- Codex `send()` 把「清空上轮结果文本」也推迟到 `turn/start` 成功后——失败/超时不再既丢计时又丢上一轮文本。
- OMP `send()` 给 `prompt` RPC 失败兜底,不再把会话卡在 `running`。

**`recentEvents` 降噪(消费方追加反馈):** `status`/`result` 里的 `recentEvents` 会进编排模型的上下文,而原来一长串 `item/agentMessage/delta`、`message_update`、`rateLimits` 心跳对编排方毫无信息量(「在流式」由 `isStreaming`/`status` 已表达)。现 `slimEvents` **丢弃逐 token / 心跳噪声并合并连续同类事件**,`recentEvents` 变成精简的 turn/工具/错误生命周期串(实测 ~454 字节)。

复测:端到端 omp+codex **18/18 通过**(含 abort-on-idle 不改 `durationMs`、`recentEvents` 无 delta 噪声断言)。

### 第三轮:逐命令调用 + 输出冗余清扫

把 **8 个 MCP 命令全部真实调一遍**抓原始输出(doctor/open/send/status/wait/result/abort/close),再用 codex + deepseek 交叉复审「还有没有冗余垃圾输出」。两方确认前两轮已清掉的(顶层重复 `logFile`、token/心跳噪声)已彻底,并指出更多。按「**只删真冗余/垃圾、且保持顶层 schema 稳定(P3)**」的原则采纳:

- 删 `session.isStreaming`:与 `status` 严格等价(`running`⇔streaming),纯冗余,全程移除(schema 仍稳定)。
- 删 `agentSpecific.sessionFile`:OMP 内部 JSONL 绝对路径,编排方用不上。
- 删 `wait` 每条结果里的 `logFile`:重复(多会话时按 N 份累积),需要日志走 `status`/`result`。
- `recentEvents` 再加噪声过滤:`message_start`/`message_end`(消息解码边界,`turn_start/turn_end` 已框定)。

**有意保留(拒绝过度精简)**:`pid`/`cwd`/`owner`(运维/UI/多宿主有用)、`byteCount`(中文等多字节答案与 `charCount` 差很多,判断体积要用)、`textRef`(P1 的「全文永远可取回」保证)、null 值的 `model`/`effort`/`lastError`(保持顶层 schema 稳定,不做 omit-when-null——那正是 P3 反对的形状漂移)。

复测:逐命令重抓确认四项删除生效;端到端 omp+codex **17/17 通过**。

---

## v0.6.1 · 运维修复:OMP 日志膨胀([issue #1](https://github.com/LeoWang329/agent-bridge/issues/1))

排查时发现 `~/.agent-bridge/logs/` 累计 **2.2GB**,单个 OMP 日志可达 **~1GB**(codex 日志全部加起来才 5.5MB)。根因:`waitIdle` 每 750ms 轮询一次 `get_state`,而 OMP 的 `get_state` 响应里 ~112KB **96–99% 是静态内容**(`dumpTools` 全量工具 schema + `systemPrompt`,每次都一样),却被 `#handleLine` 原样落盘;长会话累积即接近 1GB。这是之前 `message_update` 降噪之外的**另一个独立落盘泄漏点**。

| # | 修复 |
|---|---|
| **治本** | `#handleLine` 落盘分支跳过 `type==="response" && command==="get_state"` 的消息——get_state 响应不落盘(其动态状态仍可从响应对象实时读取)。直接消掉 96–99% 的 OMP 日志体积。 |
| **兜底** | `pruneLogs` 改为三段式(按年龄 → **单文件上限** → 总量上限,oldest-first),并在 daemon 运行期间**周期性执行**(此前只在启动时跑一次,daemon 长跑就永不清理);prune 跳过活跃会话(非 `closed`/`failed`)的 log/answer 文件,绝不删在用文件。 |
| **清理** | daemon 重启时启动期 prune 自动清掉超过单文件上限的**死会话**巨型日志(那两个孤儿会话的 omp 子进程已自行退出,日志由此被回收)。 |

新增环境变量(均可设 0 关闭该项):
- `AGENT_BRIDGE_LOG_FILE_MAX_MB`(默认 **200**):单个日志文件上限。
- `AGENT_BRIDGE_LOG_PRUNE_INTERVAL_MIN`(默认 **30**):daemon 运行期间周期性 prune 的间隔(分钟)。

> 顺带确认:OMP 的 `get_state.data` 本就带 `contextUsage:{tokens,contextWindow,percent}`、codex 的 `thread/tokenUsage/updated` 带 `tokenUsage`+`modelContextWindow`——两后端均可算上下文用量百分比,后续可低成本接入统一字段(本次未做)。

### 交叉审核(codex + deepseek-v4-pro)+ 实测

用 Agent Bridge 自身拉起 codex 与 deepseek 各做一遍独立审核。两方一致确认三项修复**正确、无回归**;deepseek 未发现新问题,codex 额外揪出 2 个真实边界缺陷,均已修复:

1. **`failed` 会话不一定是死会话**:Codex 在 turn 出错时把 `status="failed"` 但**不杀 app-server**,且 `send()` 不拒绝 `failed`——会话仍可复用继续写日志。原 `activeLogPaths` 以 `failed` 判死会误删在用日志。改为以**进程是否退出**判定(`status==="closed"` 或 `proc.exitCode!==null` 才算死;`starting`(proc 未生成)及 `failed`-但-进程活 均受保护)。
2. **启动期 prune 早于 daemon 探活**:并发启动第二个 daemon 时,新进程 sessions 为空,会按年龄/单文件上限删掉旧 daemon 正在用的日志后才退出。把启动期 `pruneLogs()` 移到 `tryDaemonPing()` 确认无其他 daemon **之后**。

两方都提的 💡:`get_last_assistant_text` 响应也全量落盘(全文已在 `answerFile` + `turn_end`),已一并归入跳过列表。

复测(0.6.1 daemon 实跑):omp+deepseek 与 codex 端到端各一轮,答案正确;OMP 日志 `get_state` 响应 **0 条**、`get_last_assistant_text` 响应 **0 条**,`prompt` ack 仍保留、最终答案仍随 `turn_end` 落盘;启动期 prune 自动清掉 2 个 >200MB 死会话巨型日志(~1.9GB),目录 2.4G→531M。

---

## v0.7.0 · 架构塌缩:daemon 收进 MCP 进程 + 移除 UI(2026-06-07)

> 完整动机与演进脉络见 [docs/ARCHITECTURE.md](ARCHITECTURE.md) 的 v0.7.0 节;这里只记消费方视角与验证过程。

**消费方视角的核心收益:** 编排者真正的诉求是「**一个主 agent 通过 MCP 拉起 N 个外部 agent,管好自己这批就够了**」。旧的"共享 daemon + UI"反而带来非需求的复杂度:会话跨客户端混在一个 daemon 里(才需要 `owner`/`mine` 来区分)、客户端退出留下孤儿会话、UI/HTTP 永驻。塌缩为「一个客户端 = 一个 MCP 进程 = 自管自己的后端」后:

- `agent_bridge_status`(无 `session_id`)列出的就是「**你自己拉起的全部**」,不再混入别的客户端——这正是「看当前主 agent 拉起了哪些 agent」的需求,且**不再需要 `mine`/`owner` 参数**(已移除)。
- 生命周期天然绑定主 agent:客户端退出 → MCP 进程退出 → 它 spawn 的 omp/codex 子进程**全部被清**(优雅退出等在途完成;SIGTERM 强制清;另有 SIGKILL force-kill 兜底)。**不再有孤儿会话堆积。**
- 不再监听任何端口(纯 stdio MCP),无 socket、无 UI;每进程独立 `logs/<runId>/`,优雅退出即删除,并发多开互不删日志。

**对消费方接口的影响:** MCP 8 个工具的入参/出参形状**不变**(v0.6.0 schema 全部保留),唯一去除的是 `session` 里的 `owner` 字段与 `status` 的 `mine` 入参——它们随"共享"概念一起消失。是破坏性变更(删字段 + 删全部 CLI 会话命令 + 删 daemon/UI),按 minor 标记 **0.6.1 → 0.7.0**。

### 分阶段实施 + 每阶段 sub-agent 测试

按 [改造计划 v3] 分 3 个代码阶段推进,**每阶段结束用独立 sub-agent 实测**后才进下一阶段:

| 阶段 | 改动 | sub-agent 实测结果 |
|---|---|---|
| **1** | `callTool` 7 个 `requestDaemon` → 进程内直调;删 `owner`/`mine`/`mcpClientId` | 全链路 open→send→wait→result→close 通过;**无 sock/无 daemon 进程**;omp 是 MCP 进程的直接子进程;`status`/`summary` 不含 `owner`。PASS |
| **2** | 移除整个 UI/HTTP/SSE 栈(~1000 行)、`http` import、UI 常量/状态 | 20 个 UI 符号全部不存在;运行中 `lsof` 确认**未监听任何 TCP 端口**;`recentEvents` 仍正常(events 缓冲保留)。PASS |
| **3** | 彻底删 daemon 全部符号/`net`、CLI 瘦身、per-run 日志、force-kill、周期 prune | 18 个 daemon 符号全无;CLI 仅剩 mcp/doctor/cleanup;SIGTERM 清子进程;per-run 目录优雅退出后删除;双进程日志目录隔离;`cleanup` 正确回收孤儿、跳过活 owner。PASS(8/8) |

### 全量 e2e

独立 sub-agent 对 **omp + codex 各跑一遍完整生命周期**(initialize→doctor→open→send(非阻塞)→wait→status→result(max_chars 截断+textRef)→复用同会话再 send→idle abort→close),外加架构不变量:**verdict PASS**(45/47;两个 red 是测试假设/产物问题,非缺陷)。要点:

- `serverInfo.version` = **0.7.0**;`tools/list` = 8;`session` 无 `owner`;`recentEvents` 正常。
- **运行中:无 sock、无 daemon pid、`lsof` 0 个 LISTEN(零网络监听)**;`logs/mcp-*` 含会话日志;后端是 MCP 进程的直接子进程。
- **优雅退出(stdin close):exit 0,`logs/mcp-*` run 目录被删除,后端子进程清掉,pid 记录清空。**
- 截断:`max_chars:5` 对 13 字符答案 → `truncated:true` + inline 5 字符 + `textRef` 全文落盘可取回(P1 保证仍成立)。

> **生命周期边界(设计如此,非缺陷):** 优雅退出的等待守卫看的是**在途 MCP 请求**(`activeRequests`),不是后台 turn。所以:推荐用法(非阻塞 send + `agent_bridge_wait`)期间 `wait` 是在途请求,stdin 关闭会**等它结算完**(实测阻塞调用等了 3579ms、turn 完成后 49ms 才退);而「光发一条非阻塞 send 就立刻退客户端」会**连同未收口的 turn 一起清掉**——这正是「客户端退出→子进程全清、不留孤儿」的预期语义。

> 实施期一个有价值的实测发现:omp 与 codex 的 stdin 都是 MCP 父进程持有的 pipe,**父进程一旦死亡,子进程因 stdin EOF 会自行退出**(~50ms)——所以「父进程被 kill 后留下长命孤儿」在实践中很难发生;`cleanup` 的孤儿回收逻辑作为兜底仍经构造场景验证正确。

### dogfood 交叉复审发现的运维缺陷,已修复(A–D)

上面那轮 DeepSeek + Codex 复审又揪出 4 个运维侧缺陷,均已修复并重测:

| # | 缺陷 | 修复 |
|---|---|---|
| **A** | `pruneLogs` 只管当前 `RUN_LOG_DIR`,崩溃/SIGKILL 退出的 server 留下的 `logs/<runId>/` 没人回收 → 目录无限累积(实测真实环境已躺着 538MB 旧日志 + 1 个孤儿目录)。 | 每个 run 写 `logs/<runId>/owner`(pid);新增 `reclaimStaleLogs()`,在**启动 / 周期 / `cleanup`** 扫掉 owner 已死的遗留 run 目录(跳过活 owner、自身、<60s 的新目录)。 |
| **B** | `cleanupAndExit` 误用 `removePidRecord:true`:`close()` 只 SIGTERM、SIGKILL 兜底是异步定时器、`process.exit()` 同步执行 → 抗信号后端活下来且记录已删,下次无法回收。**且与 `DEVELOPMENT.md` 矛盾。** | 回退为 `removePidRecord:false`,保留记录给下次启动 `cleanupStalePidRecords` 回收。 |
| **C** | `cleanupStalePidRecords` 只 SIGTERM 后即删记录,无 SIGKILL 兜底。 | 补 `scheduleForceKill`(server 启动后存活,3s 兜底能触发)。 |
| **D** | `activeLogPaths` 用 `exitCode!==null` 判死,漏判信号杀死(`signalCode`)。 | 增加 `signalCode!==null` 判定。 |

并清理一次性迁移残留:真实 `~/.agent-bridge/logs/` 的 538MB 旧扁平日志(1321 文件)+ 孤儿 run 目录全部清空。

复测(独立 sub-agent,omp + codex 全生命周期 + A–D 回归 + 运维不变量):**9/9 PASS**——版本 0.7.0、`status` 无 `mine`、会话无 `owner`;启动扫掉 dead-owner 目录且保留新目录;`cleanup` 回收遗留目录;SIGTERM 后 pid 记录留存且被 `cleanup` 回收;无 socket/端口/daemon;omp 日志 `get_state`/`get_last_assistant_text` 仍 0 条;优雅退出删自身 run 目录、子进程清。

---

## v0.8.0 · 第二轮消费方反馈(进程可识别 / 进度可见 / 批量关闭 / 误杀防护)(2026-06-09)

一位真实编排方使用者(用 agent-bridge 给 omp/codex/deepseek 派活做交叉审核)提了 6 条摩擦点。先做第一性原理评估(哪些是真缺口、哪些已被现有能力覆盖),完整评估与设计见 [docs/FIX_PLAN.md](FIX_PLAN.md)。

| # | 反馈 | 结论 | 落地 |
|---|---|---|---|
| 1 | spawn 出的进程 OS 层不可区分(omp/codex 命令行长得一样,只能靠副签名硬区分) | **修** | spawn 子进程 env 注入 `AGENT_BRIDGE_SESSION_ID`/`AGENT_BRIDGE_OWNER_PID`/`AGENT_BRIDGE_AGENT`;外部可经 `/proc/<pid>/environ`、`ps e` 归属到本桥及具体会话。`status` 本就给 `pid`,无需新查询工具。 |
| 2 | 长 `wait` 期间零进度(干等 4 分钟黑盒) | **修** | `wait` 超时(及 `mode:any` 提前命中)返回 `pendingSnapshots`:每个在跑会话 `{status,updatedAt,charCount,tail,lastEvent}`,`tail`=实时部分文本末尾(新入参 `tail_chars`,默认 240,clamp 0–4000)。一次 wait 即见"还在动 vs 卡住、在做什么"。 |
| 3 | model 不校验、不可列举 | **Level 1** | `open_session` 因后端拒绝 model 而启动失败时,错误显式带 `requested model="…"` + 指向 doctor(不断言 model 是主因,避免 ENOENT 误导)。Level 2 枚举:codex 实测无稳定列模型命令;omp 有 `omp --list-models`(SKILL 已记),留作后续低成本接入。 |
| 4 | 无 token/成本 | **跳过**(用户指定) | 内部 codex `tokenUsage`、omp `contextUsage` 已 track,将来加性接入成本极低。 |
| 5 | 缺「关掉我全部会话」兜底 | **修** | `close_session` **省略 `session_id` 即关闭本进程全部会话**(镜像 `status` 无 id=列全部);复用单关路径但 **prune 合一**,诚实返回 `{closedAll,count,sessionIds,failed}`。显式 `""`/null/非串 报错,不当全关。 |
| 6 | 非阻塞 send + 单独 wait 两步舞 | **文档** | 已可单步:`send_message(wait:true)`、`open_session(initial_prompt,wait:true)`。SKILL 点明,并补 caveat:`wait:true` **超时会 abort 该 turn**,要"等不到就继续等"须用非阻塞 send + 短超时 wait。 |

**交叉评审找出的额外真缺陷(均已修):**

- **N1 · 孤儿会话**:`openSession` 只 catch 了 `start()` 失败,没 catch 首轮 `send` 失败 → `initial_prompt+wait` 超时时 session 留在 Map、error 又不带 id → 无从关闭。改为首轮 send 失败时同 `start()` 失败一样清理再 rethrow。
- **N2 · cleanup PID 复用误杀**:旧逻辑认孤儿仅靠命令行正则,dead-owner 的 pid 记录遇 PID 复用且新进程恰好匹配 `omp --mode rpc`/`codex app-server` → 可能误杀无关进程。重写为 **confirm-before-kill**:pid 记录加 `spawnedAt`,`classifyChild` 返回 `gone|ours|reuse|unknown`——**优先用 #1 注入的 env marker 做权威身份**(`processMarkerMatches` 读 `/proc/<pid>/environ` / `ps eww`,只对 0.8.0+ 记录采信),不可读时回退 **OS 进程创建时间 vs 记录时刻**(`processStartedAtMs`;Windows CIM `CreationDate`、POSIX `ps -o lstart=` 且 `LC_ALL=C`);**身份无法确认绝不靠命令行单独 kill**。force-kill backstop 同样在 SIGKILL 前重判身份;POSIX 加 `ps` 探针守卫(ps 不可 spawn 则整轮跳过);非对象 `arguments` 在 `tools/call` 层被拒(防 `null`→`{}`→误触发全关)。

**dogfood 三轮交叉评审(用 Agent Bridge 自身拉起 codex + deepseek 各独立只读复审,逐轮发现→修→复测):**

| 轮 | 发现 | 处置 |
|---|---|---|
| **1**(评审计划) | 两方认可评估表;补出 **N1 孤儿会话**(deepseek)、**N2 误杀**(codex 标"最该优先");修订 #5 prune 合一+诚实返回、#2 覆盖 any 分支+`tail_chars` 入 schema 并 clamp、#3 仅 Level 1。 | 全数纳入 [FIX_PLAN.md](FIX_PLAN.md)。 |
| **2**(评审实现) | N2 的 locale 解析(`ps lstart` 本地化→`Date.parse` 失败)、skew 误杀窗口、force-kill 绕过守卫、`""`→全关、#3 文案误导。 | `LC_ALL=C`;改 confirm-before-kill;`scheduleForceKill` 加 verify;`session_id===undefined` 才全关;#3 不再断言因果。 |
| **3**(收敛轮) | deepseek:旧记录无 `spawnedAt` 永久漏杀 → 加 `createdAt` 兜底。codex:start-time 仍有窗口 → 改用 **env marker 权威身份**;`arguments` falsy 校验。**又抓出**:pre-0.8.0 子进程在可读 env 平台 marker=false 会被误判 reuse → 加 `expectMarker`(仅 0.8.0+ 记录采信 marker)。 |
| **4**(最终确认) | 两方一致 **converged / 已收敛**,无新回归、无遗留 blocker。 | — |

> 留作后续(非本轮,已知且低优先):`close()` 的 force-kill backstop 仍只盯 root pid,父退出后抗信号的孙进程理论上可逃逸(既有限制,非本次回归;实践中子进程随父 stdin EOF ~50ms 自退,影响极小)——根治需进程组/job object。

**版本与兼容性**:全部为**加性变更**(注入 env、`close_session` 省略 id、`wait` 新增 `pendingSnapshots`/`tail_chars`、错误信息增强、pid 记录加 `spawnedAt`),既有出参 key 不删不改名 → 既有调用零破坏,标 **0.7.0 → 0.8.0**(minor)。

**实测(Windows,JSON-RPC 驱动新 server 子进程的 e2e harness)**:**15/15 PASS**——版本 0.8.0;`close_session` schema 不强制 `session_id`、`wait` 含 `tail_chars`;空串/`null`/非对象 `arguments` 均被拒(不误触发全关);非法 model 报错带 model 名;`pendingSnapshots` 结构正确含实时 `tail`/`charCount`/`lastEvent`;批量 close 返回 `closedAll`+正确 `count`+空 `failed`,关后 `status` 为空;pid 记录含 `spawnedAt`;`cleanup` 摘要含新计数器且不崩。另以真实进程验证 N2 时间比对方向(真子进程 OS 创建时间早于记录时刻→confirmed;1h 旧记录→判 reuse 不杀)。

---

## v0.8.1 · MCP「看似断连」+ 僵尸 server 堆积 的根因修复(2026-06-10)

用户报"启动多个 Claude Code 时,只有最新的 agent-bridge MCP 能用,启动别的客户端就把当前的弄断了"。第一性原理排查(代码审计 + 受控复现,不打补丁),定位到**两个互相叠加、各自独立的根因**——完整调查见 [docs/INVESTIGATION-mcp-disconnect-2026-06-10.md](INVESTIGATION-mcp-disconnect-2026-06-10.md),复现脚本随仓库提交于 [docs/repro-mcp-hang/](repro-mcp-hang/)。

**根因 1(外部一次性,非本程序 bug):** 那次 `Connection closed @ 12:01:10` 是用户当时安装 `node-v24.16.0-x64.msi`,MSI 的 Restart Manager 在 12:01:06–12:01:10 关停了所有 `node.exe`(Windows 事件日志逐秒吻合)——每个 agent-bridge server 都是 node 进程,被一锅端;CC +7s 自动重连重试,会话在已死 server 内存里 → `Unknown session`。顺带证伪了旧假设:同会话内 4m52s/5m13s 长 `wait` 均正常完成,CC 对长调用并不在 ~60s 杀。

**根因 2(可复现的 agent-bridge bug):** `wait` 期间后端死亡会让该工具调用**永久挂死**——而非报错返回。用户感知的"MCP 断了、只有新客户端能用",真相是旧客户端的 bridge 挂死(活着但永不响应)。

| 修复 | 根因 | 落地 |
|---|---|---|
| **P1 · `request()` fail-fast** | `OmpRpcSession.request()` 无条件往 stdin 写并注册 pending;`proc close` 只清退一次,之后由 `result()/status()/abort()` 再发的请求**永无人 settle** → `wait` 永久挂死。 | 进程死/流不可写/已关闭 → 立即 reject(`dead` 标志在 process error/close、stdin error、`close()` 四处置位);补上 omp 缺失的 stdin `error` 监听(与 codex 对齐,避免 EPIPE 冒泡成 uncaughtException 杀整个 server)。 |
| **P1b · OMP RPC 超时** | 复现时又抓出一层:后端"活着但不应答"或管道半断(写仍成功)时,死活守卫帮不上,`wait` 卡死在 `await state()`,连自己的 `timeout_ms` 都到不了。 | 每条 omp RPC 加 `OMP_RPC_TIMEOUT_MS`(默认 10s,env 可调)超时并删 pending。安全前提:omp 命令全是即时 ack,长任务靠轮询观察。codex 各调用点已全有 `withTimeout`,无需改。 |
| **P2 · 退出门加宽限** | `maybeExit` 要求 `activeRequests===0`;挂死请求让它永不为 0 → 客户端退出、stdin EOF 后 server **仍无法退出** → 僵尸 server + 孤儿后端堆积(复现了 7 进程并存)。 | stdin EOF 后给在途请求 5s 宽限,到点即 `cleanupAndExit(0)`。`unref` 让自然 drain 仍优先。 |
| **P3 · 保护 crash 现场** | `cleanupAndExit` 在 `code!==0` 时刻意保留 run 目录供尸检,但任何后启 server 的 `reclaimStaleLogs` 会无条件删掉 dead-owner 目录 → 现场一轮即毁(这次 12:01 受害者就没留下痕迹,只能翻 Windows 事件日志)。 | `reclaimStaleLogs` 跳过 `bridge.log` 含 `shutdown code=非0` 且未超 `LOG_RETENTION_DAYS` 的 crash 目录;到期仍由同一轮正常老化清理。 |
| **P4 · close() 先验明正身** | `close()` 的第一枪 `terminateProcessTree(pid)` 无身份校验,仅 SIGKILL backstop 验;long-dead 后端 pid 被复用时首枪可能误伤陌生进程。 | 首枪同 backstop 一样先校验"我们的子进程句柄仍在运行"再开;codex `#handleLine` 的裸 reject-write 包 try/catch。 |

**版本与兼容性**:纯**内部健壮性修复**,不增删/改任何 MCP 工具的入参/出参形状,既有调用零破坏 → 标 **0.8.0 → 0.8.1**(patch)。新增可选 env 旋钮 `AGENT_BRIDGE_OMP_RPC_TIMEOUT_MS`(默认 10000)。

**实测(Windows,随仓库提交的 `docs/repro-mcp-hang/` harness;`fake-omp` 不发 prompt,零模型消耗)**:
- `repro-kill`:`wait` 期间 SIGKILL 后端 ×3 → 修前每次永久挂死;修后 3/3 即时返回 `status:"failed"`,且 harness 关 stdin 后 server ≤5s 干净退出(P2 自检通过)。
- `repro-pipebreak`:后端保活但断开 stdin 读端 → 修前永久挂死;修后 `wait` 按 `timeout_ms` 准时返回 `timedOut`+`pendingSnapshots`。
- e2e 回归:真实 omp `open→status→close_session` → 活后端被正常击杀(P4 未误伤正常路径),server 干净退出,`cleanup` 无残留可收。

---

## v0.8.2 · 父进程死亡看门狗(孤儿 server 自愈的最后一块)(2026-06-10)

v0.8.1 的 P2 只在 **stdin EOF** 时回收 server。但 server 可能被孤立时 stdin 管道**仍被别的进程占着**——正是那个挂了 2 天的 pid-16024 僵尸的形状:它的父进程是个**挂死(没退出)**的 `pi … models` 命令,一直握着管道,EOF 永不到来 → server 永远跑、还漏掉自己的后端。

| 修复 | 落地 |
|---|---|
| **P6 · 父进程死亡看门狗** | 启动时记下父进程 pid(`process.ppid`),用**零 spawn** 的 `process.kill(pid,0)` 廉价探活(`pidAlive`,不碰 Windows 上会冻结事件循环的 `winProcessSnapshot`),连续两拍(`PARENT_WATCHDOG_INTERVAL_MS`,默认 15s)探到父进程消失 → `cleanupAndExit(0)`:关会话、SIGTERM 后端,孤儿**自我回收**而非泄漏。`pidAlive` **失败偏安全**:只有确定性的 `ESRCH` 才算"已死"(EPERM/其它一律当活着),歧义探测绝不误杀活 server。`AGENT_BRIDGE_PARENT_PID` 可覆盖被监视 pid(supervisor/测试钩子)。 |

**范围与边界(诚实说明)**:它治的是**父进程死亡**,不是**父进程挂死**。pid-16024 那种(父进程活着但挂死)仍不自动回收——活着的父进程随时可能恢复,杀它本质上不安全。看门狗补的是更常见的"客户端进程死了、但管道还被别人占着"这条泄漏,与 stdin-EOF 路径互补。假定的 spawn 模型:客户端直接拉起 `node …mjs mcp`(ppid=客户端),这正是 README 里 CC 与 Codex 两种注册方式的形态;若用一个提前退出的 shell 包一层会误触发,故留了覆盖开关。

**版本与兼容性**:纯**加性的内部健壮性**改进(新增 env `AGENT_BRIDGE_PARENT_WATCHDOG_MS` 默认 15000、`AGENT_BRIDGE_PARENT_PID` 覆盖被监视 pid),无工具入参/出参变化、平台中立 → **0.8.1 → 0.8.2**(patch)。

**实测(Windows)**:新增 `docs/repro-mcp-hang/repro-parent-death.mjs` —— **PASS**:harness 全程**不关 server 的 stdin**、只杀一个被 `AGENT_BRIDGE_PARENT_PID` 指向的替身进程,server 仍 `code=0` 自退、后端被回收(证明是看门狗而非 stdin 路径触发)。同时回归 `repro-kill`(3/3 不挂死、P2 自检通过)、`repro-pipebreak`(按时 `timedOut`)均不受看门狗干扰。

---

## v0.8.3 · 交叉审核收口 + turn 时钟一致性(2026-06-10)

把 v0.8.1/0.8.2 的修复给 **codex / deepseek-v4-pro / minimax / xiaomi-mimo** 四家交叉审核(minimax 产出事实性错误、mimo 工具死循环,均已证伪/记录),codex 与 deepseek 一致挑出几条**真问题**;连同另一条独立记录的 [turn 时钟自相矛盾 bug](BUG-omp-turn-state-inconsistency-2026-06-10.md),一并收进本次 patch。每条都配了**确定性复现**(`docs/repro-mcp-hang/`)。

| 修复 | 根因 / 为什么 | 落地 |
|---|---|---|
| **F1 · crash 现场按 `bridge.log` 的 mtime 老化** | P3 用**目录 mtime** 判 crash 现场是否过期。但长跑 server 的目录 mtime 是**创建时刻**(条目开头一次性建好),崩在几天后目录 mtime 依旧很旧 → 现场**当场被误删**(恰好抹掉本要保的尸检)。 | 改用 `bridge.log` 自身 mtime(写到崩溃那一刻的文件)老化;`stat` 失败时**默认保留**而非走"超大年龄=删"的方向;retention≤0 时永久保留。 |
| **F2 · 看门狗"父进程启动时活着才武装"** | P6 看门狗无条件武装。若客户端经一个**随即退出的 shell 包装**拉起我们(ppid=包装器),包装器先死 → 看门狗误判客户端死亡而自杀(v0.8.2 文档已自认的边界)。 | 启动即同步探活:父进程**当下已不在**就**不武装**看门狗(它不是握着 stdin 的客户端的可靠代理),退回 stdin-EOF 信号。真实插件直接 spawn `node`,父进程必活,只兜 wrapper 边界。 |
| **F3 · `send()` 的 catch 不再把已死会话改回 idle** | prompt 被 reject 后的 catch 仅看 `proc.exitCode===null` 就回 idle;但 stdin-error/process-error/`#markUnresponsive` 可能已置 `dead=true`+`failed` 而 `exitCode` 尚未翻 → catch 把**真失败**抹成误导性的 "idle"。 | catch 守卫加 `!this.dead`:只有会话确实仍可用才回 idle。 |
| **F4 · 半死后端连续超时即判 `failed` 并回收** | 后端"进程活着、stdin 可写、但永不应答"时,`request()` 超时只 reject 单次,`wait` 仍一拍一拍 10s 超时**磨到调用方自己的(默认 30 分钟)deadline**。 | 连续 `OMP_RPC_TIMEOUT_FAILS`(默认 3)次 RPC 超时(其间无任何应答)→ 标 `dead+failed`、清退在途、**回收 wedged 子进程**;任一按时应答即清零计数(**迟到**应答不清零,持续迟到=仍判 wedged)。`wait/status` 立刻拿到失败而非干等。 |
| **F5 · 数值 env 解析失败大声回退** | `Number(process.env.X ?? d)` 对拼错的值得到 `NaN`,而所有 `NaN > 0` 守卫都为 false → **静默关掉**它本要配置的东西(RPC 超时 / 看门狗 / 日志上限),毫无痕迹。 | 统一 `envNum()`:非数值 → 打印一行警告并用默认值;`AGENT_BRIDGE_PARENT_PID` 非数值时回退 `process.ppid`。 |
| **F7+F8 · turn 时钟一致性** | 后端自行**重入 turn**(多步/工具循环,无新 `send()`)时:`turn_end` 盖了 `turnEndedAt`,随后的 `turn_start` 只翻 status 不清该戳;`lastTurnOf` 又不看 status → 报出"`status:running` 同时 `lastTurn.endedAt` 有值"的自相矛盾。更关键:`state()` 是**第二条写点**(`isStreaming` 时翻 running,同样不清戳),只改 `#applyEvent` 堵不住。 | **F7** 在 `turn_start` 清 `turnEndedAt=null`(让底层字段诚实);**F8(更重要)** 让 `lastTurnOf` **状态感知**——`running`/`starting` 一律不给 `endedAt`/`durationMs`,从**读侧**一次性封死现在和将来所有写点的滑漏。`charCount:0` 是**另一个** bug(`turn_start` 清 `lastAssistantText`),刻意不混入。 |

> codex 建议的"codex 侧补 `dead` 标志对称"**审慎跳过**:codex 的 `#write` 已校验 `stdin.destroyed`/`exitCode`,每个 `#request` 又都被 `withTimeout` 兜底,加 `dead` 标志与现有守卫重复、不治真问题(codex 真正的同类缺口是"turn 中途半死靠通知心跳",属更大改动,本次不做、单独记)。每个改动都能回答"为什么"。

**版本与兼容性**:纯**内部健壮性 + 观测一致性**修复,不增删/改任何 MCP 工具的入参/出参形状(`lastTurn` 仅由"自相矛盾"变"一致",无消费方依赖其 `running` 时的 `endedAt`)→ 标 **0.8.2 → 0.8.3**(patch)。新增可选 env 旋钮 `AGENT_BRIDGE_OMP_RPC_TIMEOUT_FAILS`(默认 3)。

**实测(Windows,`docs/repro-mcp-hang/`,均零模型消耗;新增 4 个 harness 全 PASS)**:
- `repro-turnstate`(F7/F8):后端自行 churn `turn_start→turn_end→turn_start→turn_end` 后,反复 `status` 采样——`status:running` 时 `lastTurn.endedAt` 恒 `null`。**负向对照**:临时回退 F8 后同 harness 立即 FAIL(`running` + `endedAt` 有值、`durationMs:122`),证明用例真能抓 bug。
- `repro-halfdead`(F4):后端 ack prompt 后对 `get_state` 装死;`wait` 给 60s deadline,实测 **~3.0s** 即返回 `status:"failed"`(非 `timedOut`),远早于 deadline。
- `repro-reclaim`(F1):合成 state 目录跑真 `cleanup` CLI——目录 mtime 旧、`bridge.log` mtime 新的 crash 现场**被保留**;目录与 log 双旧的 crash 现场、以及 `code=0` 的旧目录**被回收**(证明扫除确实在跑)。
- `repro-watchdog-disarm`(F2):看门狗指向一个**启动时已死**的 pid → server 4s 内**不自退**(看门狗已解除武装),随后 stdin-EOF 仍 `code=0` 干净退出。
- `repro-parent-death` / `repro-pipebreak` 回归:均不受影响、PASS。F5 单独验证:传 `AGENT_BRIDGE_OMP_RPC_TIMEOUT_MS=abc` 启动即打印回退警告、不静默失效。

**第二轮交叉审核(codex + deepseek-v4-pro 复评上面这版,两家高度一致)——再修三处:**

| 修复 | 根因 / 为什么(两家都点到) | 落地 |
|---|---|---|
| **C1 · `#applyEvent` 加 `dead` 守卫**(deepseek 判 **BLOCKER**) | `#markUnresponsive`(F4)/stdin-error 置 `failed` 后,**正在死的后端 stdout 仍可能有缓冲行**;`#applyEvent` 无条件处理 → 迟到的 `turn_end`/`turn_start` 把 status 从 `failed` 翻回 `idle`/`running`,`waitSessions` 据此把**已死后端报成正常 settled**。 | `#applyEvent` 首行 `if (this.dead) return;`:终态后一律忽略后端生命周期事件,status 只能再向前到 `closed`。 |
| **C2 · `send()` 前置拒绝终态会话** | `send()` 旧前置只查 `proc.exitCode`,不查 `dead`。`#markUnresponsive` 置 `dead+failed` 而 `proc.exitCode` 尚为 `null` 的窗口里,新 `send()` 会把 `failed` 翻成 `running`,随后 `request()` 因 dead 而 reject、F3 的 catch 又(正确地)不碰 dead 会话 → 会话**卡死在假 `running`**。 | 状态翻转前加 `if (this.dead \|\| status==="failed") throw`,直接快失败。 |
| **C3 · F4 改"静默时长"判定,免疫并发**(codex 判 Major;deepseek 判 minor 可文档化) | 原 F4 按"连续超时**计数**";若 `wait`/`status`/`result` 并发各自在飞,一个静默窗口内多条 RPC 同时超时会把计数一次性吃满,可能误杀**只是慢**的后端。 | 改记**首次超时时刻** `unresponsiveSince`(收到按时响应即清空),超时持续 ≥ `(FAILS-1)×TIMEOUT` 才判死。并发超时共享同一起点,无法提前触发;时长语义比计数更贴合"后端哑了多久"。 |

> **审慎保留/不改(附理由,非遗漏)**:F2 的"包装器启动后才死"窗口(codex Major)——deepseek 复评明确签字 F2 正确,且改成"仅显式 env 才启用看门狗"会**回退**真实插件直拉 `node`(ppid=客户端)这一主用例;此残留已在 v0.8.2/0.8.3 文档据实标注,**不为罕见边角牺牲主路径**。`close()` 把 `failed` 覆为 `closed`(deepseek minor)——会话随即从表中删除、无观测者,且改它会扰动 `proc.on("close")` 对 `status==="closed"` 的早退约定,**零收益不动**。

**第二轮实测**:全部 6 个 harness 重跑 **PASS**(`repro-halfdead` 走新的时长判定路径,~3.0s 判 `failed`)。按两家具体建议**加固两个用例**:`repro-watchdog-disarm` 现用私有 `AGENT_BRIDGE_STATE_DIR` 并**正向断言** `bridge.log` 里出现 `watchdog disarmed`(堵住 PID 复用导致的假 PASS);`repro-reclaim` 增 `retention=0`(永久保留)场景。**C1 的取舍(诚实说明)**:其错误态只存在于 `#markUnresponsive` 杀进程到 `proc.on("close")` 之间的瞬态窗口(close 后 status 本就回到 `failed`),无稳定态可断言,做确定性复现需在桥里加测试钩子、得不偿失——故 C1 以**代码审查 + 两家共识**确认,不强造易碎用例。

---

## v0.8.4 · 全文件逻辑自审:wait 合同语义 + 日志轮转 + codex 同 chunk 竞态(2026-06-10)

此前各轮评审都围绕"断连/僵尸/turn 时钟"主线;本轮对 `agent-bridge.mjs` 全文(~2600 行)做一次**不设主题的逻辑通读**,发现 4 个此前未覆盖的问题(集中在 `waitSessions` 合同语义与日志轮转——前几轮均未触及的面),全部修复并配复现/回归。

| 修复 | 根因 / 为什么 | 落地 |
|---|---|---|
| **R1 · `wait mode:"any"` 不再丢同 tick settle 的会话**(本轮最重要) | 同一轮 250ms 轮询里 ≥2 个会话已 settle 时,只有 `settledIds[0]` 进 `completed`,而 `pending` 用 `pendingIds()` 把**所有**已 settle 的都排除 → 其余会话既不在 `completed` 也不在 `pending`,按文档"拿 `pending` 循环到空"的协议,**结果被静默丢弃**。最常见触发:并行派活给 A、B,干完别的事才调 `wait`——两个都已完成,B 永远取不到。旁证:同函数的**超时分支**把所有 settled 都返回,两个出口对"多个已完成"处理自相矛盾。 | `mode:"any"` 的 `pending` 改为「`ids` 去掉本次返回的那一个」:同 tick settle 的其余会话**留在 `pending`**,下一轮 `wait` 立即逐个吐出。协议不丢数据。 |
| **R2 · 未发过 prompt 的 OMP 会话立即 settle(codex 对齐)** | OMP 的 settled 条件 `idle && turnStarted` 里,`turnStarted` 门是防"send 后、流式前"的假 idle 窗口——没错;但 **fresh 会话**它永远 false → `wait` 一个从未派活的 OMP 会话**死等到超时**(默认 30 分钟),而 fresh codex 会话(`!turn`)立即 settle。跨后端不一致,且失败形态是最贵的那种。 | **见下"评审收口"——根治为 `turnInFlight` 标志**(初版用 `everPrompted` 仅修了 fresh 一种)。 |
| **R3 · 日志轮转 rename 成功才清零计数器** | `renameSync` 失败被吞但 `written=0` 照常执行 → 内存计数与真实文件大小脱钩,之后每**再涨满一个 cap** 才重试一次 rename;而 `pruneLogs` 的单文件上限对**活跃会话文件豁免**——rename 持续失败(被扫描器/tailer 短暂锁住)的长寿会话日志按 cap 步长无界增长,恰好绕过轮转要防的问题。 | 清零移进 `try` 内、仅 rename 成功后执行;失败则**每次后续 append 都重试**轮转直到成功。 |
| **R4 · codex `turn/start` 响应与通知同 chunk 的竞态** | 回合簿记(清空累积文本/盖时间戳/采纳 turn id)在 `await` 续延里执行,但注释声称的"先于任何通知 tick"在**同一 stdout flush** 场景不成立:readline 同步连发整个 chunk 的行,microtask 续延要等同步链跑完。后果:① 先到的 deltas 落在**上一轮文本之后**、再被 reset 抹掉;② 极端情况(响应+整个 turn 生命周期同 chunk,如瞬时失败)turn 先 settle,续延见 `this.turn !== myTurn` 误走 "abort 介入"分支——给**已完成**的 turn 发 interrupt 并误报 `accepted:false`。 | 抽出**幂等** `#beginTurn()`(按 `turn.begun` 一次性簿记),在 `turn/started` 通知与响应续延**先到者执行**;`#settleTurn` 在 turn 对象上记 `settled:{err,status}`,续延据此区分"已完成"(如实返回 `accepted:true`/结果/原错误)与"被 abort/close 抢走"(维持原 `accepted:false`+interrupt)。失败/超时的 `turn/start` 仍不触发簿记,上一轮的 lastTurn 与结果文本照旧保留。 |

**自审同时记录、本轮审慎不修的次要项**(均为低概率/有界,避免无收益扰动):stdin-error 路径只标 `failed` 不收割子进程(活到 `close_session`/server 退出,有界泄漏;与 `#markUnresponsive` 会 reap 不一致);`unresponsiveSince` 跨长空闲期可因两次相隔很久的孤立超时误判(C3 时长法的已知代价);`extractAssistantText`/`extractLikelyText` 死代码;`doctor` 的 `spawnSync` 无超时;`AGENT_BRIDGE_PARENT_PID` 为非整数时看门狗静默跳过(连 disarm 日志都没有)。

**版本与兼容性**:不增删/改任何 MCP 工具的入参/出参**形状**。R1 是**合同语义修正**:`mode:"any"` 的 `pending` 现在可能包含**已 settle** 的 id(下一轮 wait 立即返回它们;`pendingSnapshots` 如实显示其 `idle`/`failed` 状态)——按文档循环的消费方行为只会变正确,不会变坏 → 标 **0.8.3 → 0.8.4**(patch)。

**实测(Windows,零模型消耗)**:新增 `docs/repro-mcp-hang/repro-waitany.mjs`(fake-omp `turnstate` 模式驱动真 MCP server),**负向对照成立**——修复前同 harness 即 FAIL(`wait#1` 返回 `pending=[]`,B 被丢);修复后 **PASS**:R1 两个同时 settle 的会话经 `completed→pending→completed` 全部取到;R2 fresh 会话 `wait` **46ms** 即返回(修复前吃满超时)。R4 无法确定性构造(需后端把响应与通知打进同一 flush),以代码审查覆盖。既有 7 个 harness 全量回归 **7/7 PASS**(turnstate / halfdead / reclaim / watchdog-disarm / pipebreak / parent-death / kill)。

### 评审收口(codex + deepseek-v4-pro 交叉复评)+ R2 根治

用 Agent Bridge 自身拉起 **codex** 与 **omp/deepseek-v4-pro** 各做一遍独立只读评审(两个不同引擎=真第二意见)。两家**高度收敛**:R1 / R3 / R4 一致判 **PASS、无回归**(R4 的 `#beginTurn` 幂等性与 `myTurn.settled` 在"同 flush 通知先到 / 续延先到 / abort / close / 终态状态竞态"五条流程被逐一走通、判为 watertight;R1 对 `mode:"all"` 与超时分支无影响)。

两家**独立指向同一个边角**(codex 判 MAJOR、deepseek 判 MINOR/B1,均明确"**非本次引入的回归**"):`everPrompted` 表达的是"**尝试过 prompt**",不是"**有在途 turn 可等**"——所以 ① prompt 被后端拒绝(`send()` catch 回 idle 但 `everPrompted` 仍 true),或 ② 首个 prompt ack 后、流式前被 `abort()`,都会留下 `idle + turnStarted=false + everPrompted=true` → `wait` 仍死等到超时。情形 ① 在"**开 N 会话、逐个 send、再 wait 我开的全部 N 个 id**"这一常见编排模式下**可达**(消费方记的是 open 的 id,不是 send 的 ack)。

**根治(不打补丁)**:`everPrompted` 这个"一旦置真永不复位"的代理量本身就是根因。改为 **`turnInFlight`**——`send()` 入口**同步**置真(覆盖首次与复用会话的 pre-ack 窗口),在**每个 turn 终止点**复位:`turn_end`/`agent_end`(完成)、`abort()`(取消)、prompt 被拒的 catch(无 turn)。`sessionSettled(omp) = idle && !turnInFlight`,一个谓词同时正确覆盖 fresh / 完成 / 失败 / abort 四态,且**不依赖观测到 `agent_start`**;真正在途的 pre-stream turn 期间标志恒为真,绝不提前 settle(终态 `failed`/`closed` 在更前面短路,无需复位)。`turnStarted` 仍单独服务 `waitIdle` 的内联等待路径,不动。

**实测**:新增 `docs/repro-mcp-hang/repro-waitfail.mjs`(fake-omp 新增 `rejectprompt` 模式:拒绝每个 prompt、保活 idle)。**负向对照成立**——临时去掉 catch 里的 `turnInFlight=false` 即 FAIL(死等满 6068ms 超时);修复后 **PASS**:被拒会话 `wait` **45ms** 即 settle。全量 **9/9 PASS**(waitfail / waitany / turnstate / halfdead / reclaim / watchdog-disarm / pipebreak / parent-death / kill)。按用户决定**本轮不再追加评审一轮**,以负向对照 + 全量回归 + 两家已收敛的共识收口。

> **schema 文案待办(已知,未计入逻辑缺陷)**:两家都点到 `agent_bridge_wait` 的入参/出参描述仍说 `mode:"any"` 的 `pending`/`pendingSnapshots` 是"still-running ids",与 R1 新语义(可能含同 tick 已 settle 的 id)不一致。属文档措辞,留待后续低成本订正。
