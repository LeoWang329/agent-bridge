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
