# Agent Bridge — 架构演进记录 (Architecture Evolution Log)

> 这份文档记录 Agent Bridge 关键架构决策的**演进脉络**:每个版本改了什么、**为什么**、移除了什么。
> 倒序排列(最新在上)。每次大的架构改动在顶部追加一节。给后续迭代的 agent 看,以理解"为什么现在长这样"。
>
> 当前架构权威说明见 [README.md](../README.md)(用户向)与 [DEVELOPMENT.md](DEVELOPMENT.md)(开发向)。

---

## v0.10.0 — 收口纪律加固(2026-07-26,**破坏性**:wait 默认返回形状 + close 合同)

**起因:** 主 agent 用桥派活后**经常忘记收口** —— 拿到非阻塞 ack 就往下走,甚至直接 `close_session`,那一轮产出被丢弃或被半成品冒充。

**根因不是"提示词没写"**(已证伪:`skills/agent-bridge/SKILL.md` 里 22 行含 `wait`;稳定安装 clone 与开发 clone 的主 skill SHA-256 一致),**而是"写在会掉的那份里,桥在 agent 做决定的那一刻不提醒"**。具体八条:ack 没有"结果尚未交付"的语义;桥**没有任何主动唤醒机制**,而宿主"长调用转后台+事后通知"的经验恰好把 agent 训练成相反的先验(通知的前提是**有一个 wait 在飞**);`send_message.timeout_ms` 在默认 `wait:false` 下是**静默无效参数**(最可信的误解模型);收口义务从未被写成禁令;唯一常驻上下文的那份(MCP tool schema)写得最弱;`close_session` 没有在途闸门且会**摧毁证据**;`open_session(initial_prompt)` 是更隐蔽的 ack 路径;"已经 wait 过一次"也会半途而废。

**变更(四批,各自独立提交):**
- **C2(破坏性)`agent_bridge_wait` 的 `mode` 默认 `all` → `any`。** 默认从此等于一直以来推荐的用法,且 `any` 的返回天然带 `pending`,正是挂"必须继续收"信号的位置。⚠️ **默认返回形状随之翻转**:`{mode, results}` → `{mode, completed, pending, pendingSnapshots}`;单会话时两者返回**时机**几乎一样,差别纯在形状,所以"省略 mode + 读 `results[0]`"会静默拿到 `undefined`。三个返回点都回显 `mode` 供判别(既有设计)。
- **C3 join 时钟与 inline 时钟分离。** 新增 `DEFAULT_JOIN_TIMEOUT_MS`(10 分钟,`AGENT_BRIDGE_JOIN_TIMEOUT_MS` 可覆盖),**只**给 `waitSessions` 用;`DEFAULT_WAIT_TIMEOUT_MS`(30 分钟)的另外五个读取点**一个都不动**。理由是两者超时后果相反:join 超时**非破坏性**(返回 `{timedOut,…}`,turn 继续跑),inline 超时**进入破坏性 abort/interrupt/tree-kill**,砍短等于开始摧毁合法长 turn(实测本仓跨模型复审 turn 跑过 15.6 / 16.2 分钟)。边界校验只对新常量收紧(拒负数/小数/非安全整数,**`0` 也拒** —— 本仓 `0` 是"关闭该功能"的惯例,而"关闭 join 超时"读作永远等,正是要消灭的死等),**不改 `envNum()` 本身**。
- **C1 ack 与未完成收集自报"你还没拿到结果"。** 两个装饰器而非一个:ack 里确实什么都没有(`resultIncluded:false`),而 wait 的 any/超时返回**已经交付了部分结果**,只能声明 `collectionComplete:false`。装饰器**绝不能说谎**是这里的第一原则。续等条件写成"`pending` 非空"而非"`timedOut`"(超时可以合法返回 `pending:[]`,照着 timedOut 续等会把空数组撞上 `session_ids` 非空硬校验)。
- **C5 中途快照如实标注。** 新增 `turnSettled`/`inProgress`,语义**严格**限定为"共享判定 `sessionSettled` 此刻是否视为可交付",不表示成功/正文完整/远端已停(`failed`+`turnSettled:true` 合法)。**不用 `complete`/`partial`** —— abort 之后 settled 为真但正文是片段,叫 complete 是新的谎言。structured output 在 running 时 `json:null` + `schemaPending:true`,不再对半截 JSON 产出看似最终失败的 `schemaError`。
- **C6(破坏性)在途 turn 默认拒绝关闭。** `close_session` 加 `force`;不传时对未终态会话返回 `{blocked:true, runningSessionIds}` 且**什么都不关**,批量形式是**原子 preflight**(任一在跑则一个都不关)。⚠️ 口径:这只拦得住"**未终态**",拦不住"**已终态但结果从未被取走**" —— 真正的未收口需要一个由 `result()`/`waitSessions` 置位的 `collected` 标志,本轮不做,别宣称 R6 已全解。

**测试:** 新增 `docs/repro-mcp-hang/repro-collect-discipline.mjs`(T1–T28,143 断言),配套新增四个桩:`fake-omp` 的 `slowsettle`/`partialslow`、`fake-codex` 的 `sameflush`/`slowstart`/`schemaslowpartial`。同时修掉一处**既有假绿**:`repro-turnstate` 的收尾 close 从不检查响应,加闸门后会被静默挡住而测试照绿。

**施工说明书:** `docs/PLAN-collect-discipline-hardening-2026-07-26.md`(含两轮异引擎复审闭环与全部"不要做什么")。

**顺带订正说明书的一处事实错误:** T14 不能用 `slowturn` —— 它的 `get_state` 恒报 `isStreaming:true`,而 `waitIdle` 要的正是 `!isStreaming`,所以 inline `wait:true` 在它上面**永远完不成**,那条用例会退化成"卡满 30 分钟"而不是在考时钟隔离。为此新增了会如实收尾的 `slowsettle`。

---

## v0.9.1 — 诊断日志单行封顶 + 正文不落盘(2026-07-18,根因修复)

**变更:** (1) `appendLog()` 内加**每次写入的字节上限** `AGENT_BRIDGE_LOG_LINE_MAX_BYTES`(默认 4096,合法值为 0 或 ≥512 的整数),超限写头部 + `…[+<n>B truncated]` 标记;(2) `stripThinking()` 扩为 `redactForLog()`——除原有的思维链字段外,还把**已知正文键**(`aggregatedOutput` / `aggregated_output` / `text` / `delta` / `output`,以及仅当取值是字符串时的 `content` / `displayContent`)换成尺寸标记,其余字符串按 `AGENT_BRIDGE_LOG_FIELD_MAX_CHARS`(默认 512)夹断。

**口径(重要,别读成更强的承诺):** 这是"**已知正文键不落盘**",**不是** schema 无关的零泄露。一个我们尚未识别的正文字段仍会在日志里留下**开头 512 字符**——这是"对未知 schema 反脆弱(有下界)"与"零泄露"之间的折中,不是二者兼得。把新出现的正文键补进 `LOG_BODY_KEYS` 只能让**已知 schema** 的正文不落盘,**得不到** schema 无关的零泄露;后者需要换策略——改成**骨架 allowlist**(只记白名单字段)或**默认丢弃一切未知字符串**,本次没做。体积则由 `appendLog` 的上限兜住(那一层才是 schema 无关的,前提是 cap 未被显式设为 `0`)。

**为什么:** 前两次(`message_update` 的 O(n²) 重序列化、v0.6.1 的 `get_state`/`get_last_assistant_text`)都是"**发现哪类事件刷量就加一条类型排除**"。这是打地鼠:单行本身**无上限**,每接一个新后端就重新开一个洞。codex 的洞一直敞着——`item/completed` 携带命令全量输出,实测单个会话日志 8.7MB、**最长单行 1,583,143 字节**。类型排除清单治标;`appendLog` 是所有日志写入的唯一漏斗,把上限放在这里才是普适下界,新后端绕不过。同时 codex/omp 由此对齐 claude/cursor/kimi 既有的"正文不逐字落盘"隐私策略(命令本身、exit code、item 类型等骨架保留,诊断价值不丢)——注意那三个后端是按**事件类型**整条跳过,codex/omp 是按**字段**脱敏,两者的覆盖面并不等价(见上面的口径说明)。

**边界:** 只作用于诊断 `.log` / exit-journal。`answerFile` / `textRef` / MCP 返回的 `text` 仍是**完整未截断全文**——产品契约不变。回归见 `docs/repro-mcp-hang/repro-log-bounds.mjs`(74/74)。

**异引擎复审后的收口(同版本内):** `appendLog` **不开任何豁免**——一开豁免就退回打地鼠。由此产生的四处配套修正:(a) exit-journal 记录改为在**序列化前**按写入预算裁剪 `sessions[]` 整个元素并记 `sessionCount`/`sessionsOmitted`,否则字节级截断会写出**不可 `JSON.parse`** 的行(实测 ~45 会话即触发);(b) claude `type==="result"` 的 `result` 字段是答案原文,在 **claude 事件路径**上显式 elide(**不进** `LOG_BODY_KEYS`——裸键 `result` 也是 codex JSON-RPC 信封的结构体,全局 elide 会毁掉骨架);(c) omp stderr 补 `setEncoding("utf8")`——原先逐 chunk `toString("utf8")` 会把跨 chunk 的多字节字符解成两个替换字符(它是最后一条 Buffer 入口);(d) `redactForLog` 深度超限改为返回 `<elided deep object>`(原先返回原对象=未脱敏子树),且 `content`/`displayContent` 仅在**是字符串时**才整体 elide,是结构时递归保留 `type`/`name`/`id` 而只 elide 内部 `text`/`output` 叶子。上限语义同时收紧:marker 从预算内扣除,单次写入**恒 ≤ 上限**。

**第二轮复审的收尾:** (e) 配置入口加 `envByteCap()`——上限必须是 0 或 **≥`LOG_LINE_MIN_BYTES`(512)的整数**。理由是小数(`4096.5` → 写 4097B、marker 谎报 `926.5B`)和过小值(`10` → marker 本身就比上限大,写 22B;`200` → exit-journal 记录不可 parse)会**静默**破坏上面两条承诺;512 是零-session 记录(192–260B)+ marker(~25B)所需的下界。**非法值按"意图方向"分两类处理**,不一刀切:低于下限的**正整数**(`200`/`10`)意图是"收得更紧",方向合法 → **夹到 512**(一律回退默认会把请求**反转**——要 200 的人拿到 4096,反而宽 20 倍);**格式非法**(小数/负数/非数字)没有可尊重的方向 → 回退默认 4096。两类的告警措辞不同(`clamped to 512` vs `using default 4096`),回归里也分别断言**生效上限**而不仅是文案。`fitExitJournalRecord` 另加一道:先确认**零-session 骨架**放得下(放不下就削 `reason`,它是唯一非构造有界的字段),再往里塞 session。(f) "不得把裸 Buffer 传进 `appendLog`"这条不变式从注释提升为代码:`normalizeLogPayload()` 用 `isUtf8()` 校验,合法转字符串,**不合法则丢弃并写一条诊断标记(进程内只告警一次),绝不抛异常**——避免将来有人新加一条裸 Buffer 流时静默复发跨 chunk 乱码。 (g) `envNum()` 把**纯空白**值(` ` / `	`,来自 .env/模板/部署系统很常见)当作**格式非法**而非显式零——此前 `Number(" ")===0` 会被每个 "0 即关闭" 的消费方读成用户主动关了,**静默把本次唯一 schema 无关的体积防线整个摘掉**(实测单行回到 2,000,018B)。只有写成数字的 `0` 才关闭;真正的空串 `""` 保持既有的未设置语义。修在 `envNum` 而非 `envByteCap`,因为同一个坑对 `LOG_RETENTION_DAYS`(变成永久保留)等 19 个消费方同样成立。

---

## v0.7.0 — daemon 塌缩进 MCP 进程,移除 UI(2026-06-07)

**一句话:** 把"共享后台 daemon + Web UI"两层去掉,会话直接活在每个客户端自己的 MCP server 进程里。

### 变更
- **collapse daemon → MCP 进程**:不再有独立常驻 daemon、Unix socket、`requestDaemon` 转发。`agent-bridge mcp` 进程**自己持有** `sessions` Map,`callTool` 直接进程内调用 `openSession`/`sendMessage`/… 后端(omp/codex)作为 MCP 进程的**子进程**被 spawn。
- **移除整个 UI / HTTP / SSE 栈**:删掉 `startUiServer`/HTTP 路由/SSE 广播/`renderUiHtml` 等约 1000 行。不再监听任何端口;只走 stdio MCP。`session.events` 缓冲保留(供 `status`/`result` 的 `recentEvents`),只是不再向 SSE 广播。
- **per-process 作用域**:每个 MCP server 一个 `logs/<runId>/` 日志目录,prune 只管自己这一份 → 并发的多个 server 互不删日志。优雅退出删除本 run 目录;崩溃(code≠0)保留以便排查,但每个 run 目录带一个 `owner`(pid)文件,**下次任意 server 启动或 `cleanup` 会回收 owner 已死的遗留 run 目录**,所以崩溃残留不会累积。周期 prune 定时器搬进 `serveMcp`。
- **移除 owner / mine**:会话不再跨客户端共享,所以"哪个宿主开的"这个维度没意义了。删 `owner` 字段、`status` 的 `mine` 过滤、`mcpClientId()`。
- **CLI 瘦身**:只保留 `mcp` / `doctor` / `cleanup`。删掉 `daemon`/`start`/`stop`/`ui`/`sessions`/`open`/`send`/`status`/`result`/`wait`/`abort`/`close`。`cleanup` 只做"回收被 kill 的 server 残留的孤儿子进程"。
- **生命周期收尾**:`cleanupAndExit` 去掉 daemon socket/pid-file 清理;OMP `close()` 补 `scheduleForceKill` 兜底(与 codex 对齐);pid-record 的 owner 判活正则从 `mcp|daemon` 收为 `mcp`。

### 为什么
真实诉求是:**一个主 agent(一个客户端)通过 MCP 拉起 N 个外部 agent,只要能管理"自己拉起的这批"就够了。** 跨客户端共享、Web UI 都不是需求。

旧的"共享 daemon + UI"模型带来的恰恰是不需要的复杂度和真实的运维痛点:
- daemon 永不退出,一个客户端退出后会留下**孤儿后端会话**,要等下次 daemon 启动或手动 `cleanup` 才回收。
- 多个客户端的会话混在一个 daemon 里,`status` 默认能看到别人的,才不得不引入 `owner`/`mine` 来区分——这是为"共享"这个非需求付出的成本。
- UI/HTTP 是 daemon 需要常驻的理由之一;既然不需要共享视图,UI 也一并去掉。

塌缩成"一个客户端 = 一个 MCP 进程 = 自管自己的后端会话"后:生命周期天然绑定主 agent(客户端退出→进程退出→子进程全清),作用域天然隔离(进程内 `sessions` 就只有自己的),`owner`/`mine`/UI/socket/daemon 全部消失。

### 迁移提示
升级后,旧的 0.6.x daemon **不会自动退出**(新版已无 daemon 感知代码)。残留的旧 daemon 可手动清掉一次:
```sh
pkill -f 'agent-bridge.mjs daemon'
```
0.7.0 的会话日志都写在 `logs/<runId>/` 子目录里;0.6.x 时期遗留在 `~/.agent-bridge/logs/` 根部的**扁平日志** `*.log`(及旧 `daemon.log`)新版不会再写、也不归 per-run prune 管,属一次性迁移残留,升级时清掉即可:
```sh
find "$HOME/.agent-bridge/logs" -maxdepth 1 -type f -name '*.log' -delete
```
(0.7.0 自身的崩溃残留 `logs/<runId>/` 目录由启动/`cleanup` 自动回收,无需手动处理。)

---

## v0.6.1 — OMP 日志膨胀修复(2026-06-07, issue #1)

**变更:** 停止把 OMP 的 `get_state` / `get_last_assistant_text` **响应**落盘(`#handleLine` 里跳过这两类 response);加单文件上限 `AGENT_BRIDGE_LOG_FILE_MAX_MB`(默认 200)与周期 prune `AGENT_BRIDGE_LOG_PRUNE_INTERVAL_MIN`(默认 30)。

**为什么:** `waitIdle` 每 750ms 轮询一次 `get_state`,其响应里 96–99% 是基本不变的 `dumpTools`(~89KB)+ `systemPrompt`(~20KB),逐条落盘把单个会话日志撑到近 1GB。治本是这类大而静态的响应不落盘。经 codex+deepseek 交叉评审,额外修了两个缺陷:孤儿活跃会话的判活(failed≠dead,改用 `procExited`)、start-time prune 与并发第二 daemon 的竞态。

---

## v0.6.0 — 消费侧反馈 schema 大改(P1–P6)

**变更:** 统一出参 schema——入参 snake_case、出参一律 camelCase;`session` 两后端**形状一致**(公共核心字段 + `lastTurn` + `agentSpecific` 收纳后端差异);`result`/`wait` 文本永远报 `charCount`/`byteCount`、完整全文写入 `textRef`、`max_chars` 截断不静默丢内容;`recentEvents` 过滤逐 token/心跳噪声。经交叉评审加固。

**为什么:** 消费方(主 agent)反馈出参形状随后端漂移、原始事件把上下文撑成"一团 blob"、长产出被静默截断。目标是让委托结果**可预测、可判断、不丢必读内容**。

---

## v0.5.x — 共享 daemon + 多后端期(后被 v0.7.0 取代)

这一系列围绕"共享 daemon + UI + 多后端"展开,其中很多机制在 v0.7.0 被移除,但解决的问题值得记录:

- **0.5.0:** 加 `agent_bridge_wait`(阻塞 join,`all`/`any`),用于并行 fan-out 收口。
- **0.5.1 / 0.5.7:** `send_message` 默认阻塞 ↔ 非阻塞来回调整,最终定为**非阻塞 + 短超时 wait 轮询**(避免主 agent 死等 30 分钟硬上限)。
- **0.5.2 / 0.5.3 / 0.5.4:** 一系列日志/产出瘦身——slim result payload、不落盘流式 delta 快照、绑定日志保留 + 从日志剥离 thinking。
- **0.5.5:** daemon 中途关闭连接时及时 reject,不再让请求挂到超时。
- **0.5.6:** 自动给会话盖 `owner`(开它的客户端)+ `status` 的 `mine` 过滤。**→ v0.7.0 移除**:不再共享,作用域天然隔离,owner/mine 失去意义。

### 更早:后端收敛(v0.4.0)
**移除 OpenCode 后端**(2026-06-06,因其重且不稳),桥只保留 `omp` + `codex` 两个后端。早期还修过一批 turn-boundary 污染 / 并发 send / start-abort 竞态。
