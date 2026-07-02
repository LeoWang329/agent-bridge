# Agent Bridge 修复计划（重度用户提案三方评审后 · v2 已并入 plan-review 修正）

> 来源：`docs/PROPOSAL-heavy-user-optimizations-2026-07-01.md` 经 deepseek-v4-pro + codex + 主 agent 三方评审后收敛的可执行清单。
> 本计划 v1 又经 deepseek + codex 二次评审（针对计划本身），下列修正已并入：T1 shape 契约、T2 环境变量名、T3/T4 精确行、T4 补 OMP stderr、T7 命名冲突、T10 路径护栏用 `path.relative`+双端 realpath、T11 per-turn schema 状态 + Codex failed-turn 路径、新增 N2 校验助手前置任务。
> 全部实现都在单文件 `scripts/agent-bridge.mjs`。日期：2026-07-02

## 执行协议（每个 task 都走这套闭环）
1. 主 agent 实现该 task 的最小正确改动。
2. 主 agent 写/扩测试并**自己跑通**（fake 后端的 `repro-*.mjs` 走确定性；用户可见行为再进 `e2e-real.mjs` 跑真后端）。
3. `git diff` 交给 **codex + deepseek 两个独立只读会话**并行交叉审核：审 diff 正确性 + 审"测试是否真的验证了该修复" + 顺藤看有没有引入新问题；能自己跑就自己跑。
4. 两方都判定 **通过、无问题** 才 `git commit`，进入下一个 task；有问题就修→复审，直到干净。
5. 评审者恒 ≠ 实施者（引擎不同才算真第二意见）。

> **不考虑 token / 成本**（用户明确指示）：本计划一切取舍只看**质量、正确性、验证充分度**，不为省 token 缩减 effort、并行度或复核轮次。（因此原 T8「usage/token 计量」已删除——它的唯一动机是成本可见性。）

## 验证基线（每个 task 至少满足）
- `node docs/repro-mcp-hang/<相关 repro>.mjs` 全 PASS。
- 触及用户可见接口的：`node docs/repro-mcp-hang/e2e-real.mjs` 相关场景 `>>> PASS`。
- 回归：跑既有相关 repro（`repro-turnstate`/`repro-waitany`/`repro-waitfail`/`repro-halfdead`）确认无破坏。

## 范围
- **纳入**：A 档功能 A1/A2/A3/A5、拦路实现级修复 N1（路径安全）/N2（入参校验）/N3（wait 字段透传）、既有潜伏 bug P1–P5。
- **删除**：~~A4 usage/token 计量~~（成本不予考虑）。
- **排除**（评审"以后做/需重设计/拒绝"）：`output_to`、跨后端 schema+retry、在途结构化进度、fan-out 原语、review 打包助手、doctor 真探活、逐消息 `write:true`、生成式 `summary` 返回。逐消息 `write:true` 触及安全模型，留作未来独立提案。

## 全局契约：新增返回字段放哪（两评审都要求先定死）
- **会话级事实**（`lastStderr`、`health`）→ 加进各后端 `summary()`。于是它们出现在 `status().session.*`、也出现在 `result().session.*`。
- **turn 级结果**（`json`、`schemaError`）→ 由 `buildSessionResult` 放在**结果 payload 顶层**。
- **`buildSessionResult` 顶层同时"上提" `health`**（从 session 读），使 `result().health` / `wait().completed.health` 顶层可读。
- **`wait()` 的 `summarize()`（见 T1）**：spread `result()` 的 payload，但**剔除 `session` 与 `recentEvents` 两个重字段**（避免把整份 session 快照/事件流灌进 wait 结果，违背上下文卫生），再补 `sessionId`/`status`/`lastTurn`。→ 现有 wait 输出的键**逐字不变**，且 buildSessionResult 顶层新增的标量字段（`json`/`schemaError`/`health`）**自动透传**。这是 N3 的真正形状。

---

## 任务清单（按依赖排序）

### Phase 0 — 地基

#### T1 · (N3) `wait()` 结果字段透传（+ 定义上面的全局契约）
- **问题/根因**：`summarize()`（`:2689-2703`）手抄固定字段、不 spread `result()`。→ buildSessionResult 顶层新增字段被 `wait` 静默丢弃，而 wait 是 A1 读 `json`、A5 读 `health` 的主收口。
- **核实**：`result(id)`→`session.result()`→`buildSessionResult(this,full,options)`（三后端 `:1488/2066/2413`）。`buildSessionResult` 返回 `{session,text,charCount,byteCount,truncated,textRef,recentEvents}`（`:550`）。
- **修法**：`summarize()` 改为：
  ```js
  const r = await result(id, { maxChars: params.max_chars }).catch(() => null);
  if (!r) return { sessionId: id, status: session.status, text: null, gone: false };
  const { session: _s, recentEvents: _e, ...rest } = r;   // 剔重字段
  return { sessionId: id, status: session.status, ...rest, lastTurn: lastTurnOf(session) };
  ```
- **形状契约（两评审强制）**：现有 wait 输出键不变；新增标量字段靠 `...rest` 自动透传。**明确记录：这是有意的透传机制，不是意外泄漏 `session`/`recentEvents`**（恰恰相反，我们剔除了它们）。
- **验证**：
  - 回归：`repro-waitany.mjs`（fake-omp）断言 `wait(any)`/`wait(all)` 输出键与旧版一致（sessionId/status/text/charCount/byteCount/truncated/textRef/lastTurn），且 `session`/`recentEvents` 不出现在顶层。
  - 超时 shape：断言 `timedOut` 分支的 `settled[i]` 走同一 `summarize`，形状一致（codex C-T1 补的 gap）。
  - 透传本身的**确定性证明**推迟到 T9（health 是第一个顶层新字段）——那时断言 `wait().completed.health` 存在，即证明机制成立（避免临时探针字段，回应 codex）。
- **验收**：`repro-waitfail.mjs` 回归 PASS。

### Phase 1 — 既有潜伏 bug

#### T2 · (P3) `doctor()` spawnSync 无超时
- **根因**：`doctor()`（`:2807`）每后端 `spawnSync(--version)` 无 timeout，卡住吊死 MCP 请求。
- **修法**：新增常量 `DOCTOR_PROBE_TIMEOUT_MS = envNum("AGENT_BRIDGE_DOCTOR_PROBE_TIMEOUT_MS", 10_000)`（**不复用** `WIN_PS_SNAPSHOT_TIMEOUT_MS`，语义不同——deepseek）。`spawnSync(..., { timeout, killSignal:"SIGTERM" })`。超时→`available:false`、`error:"version probe timed out"`。
- **验证**：`probe-doctor-timeout.mjs`——**用 `OMP_BIN` 指向一个永不退出的脚本**（不是 `AGENT_BRIDGE_OMP_BIN`；`agentBin()` 读 `AGENTS[agent].env` 即 `OMP_BIN`/`CODEX_BIN`/`CLAUDE_BIN`，见 `:80/:330`——两评审都纠正了这个名字）。断言 doctor 在 ~timeout 内返回、该后端 unavailable、不吊死。
- **验收**：真 `node scripts/agent-bridge.mjs doctor` 仍正常。

#### T3 · (P2) OMP `send()` 缺并发轮护栏
- **根因**：`OmpRpcSession.send()`（守卫在 `:1416-1421`，`this.turnInFlight = true` 在 `:1425`）无"turn 进行中则拒绝"；codex（`:1944`）/claude（`:2369`）都有。
- **修法**：在现有 dead/failed/proc 守卫之后、**`this.turnInFlight = true` 之前**插入 `if (this.turnInFlight) throw new Error(\`OMP session ${this.id} already has a running turn; wait for it to finish.\`);`（与另两后端报错语义对齐）。
- **验证**：`repro-omp-concurrent.mjs`（fake-omp 慢 turn）：第二次并发 `send` 立即抛错、首 turn 不受影响、完成后可再 `send`。
- **验收**：`repro-waitany.mjs` 等 OMP 顺序 re-prompt 用例回归 PASS（没误伤正常复用）。
- **已知限制（codex 复审提出，已实测复现）**：OMP 的 turn_end/agent_end **不带 turn id**，`#applyEvent` 只能无差别清 `turnInFlight`。因此一个 **已 abort 的旧 turn 的迟到 terminal**，若在新 `send()` 已 arm 新 turn 之后才到达，会错误清掉新 turn 的 in-flight 标志、绕过本护栏（scratchpad 探针实测 send#4 被误接受）。**不修**：唯一的关联办法是"abort 后吞掉 N 个 terminal"计数器，但它只在"后端 abort 后必发 terminal"时才正确；若后端有时不发，计数器会吞掉**下一个真 terminal** → 会话永久卡死（更糟）。正确修法需要 OMP 协议提供 turn id（当前没有）。实际窗口很小（abort→立刻重发→旧 turn 的迟到 terminal；真实 abort 通常即时终止）。代码 `#applyEvent` 处已注释，列为后续。

#### T4 · (P1) `lastError` 粘滞（分通道 stderr / error）
- **根因**：`lastError` 仅构造置 `null`（`:1092/1616/2180`），成功轮不清零；且**三后端**都在 `stderr.on("data")` 每块写 `lastError`——OMP `:1189`、Codex `:1653`、Claude `:2226`（**codex 补出 OMP 1189，deepseek 漏了；已核实 1186-1189 确为 OMP stderr handler**）。→ 一条无害 stderr 永久污染 `status.lastError`。
- **修法（方案 a：分通道）**：
  - **移到 `lastStderr`**（诊断用，非错误）：OMP `:1189`、Codex `:1653`、Claude `:2226` 三处 `stderr.on("data")`。
  - **保持 `lastError`**（真失败）：进程 error/close 非 0、stdin error、turn/RPC error、`#markUnresponsive`、`#settleTurn(err)`、`turn/start` timeout 等——即 deepseek/codex 列出的其余全部写点。
  - **close 处理器不改**：`this.lastError = code === 0 ? this.lastError : "...exited code N"`（`:1214/1682/2241`）——stderr 移走后，`code===0` 分支保留的就只是"退出前的真错误或 null"，语义自然正确（deepseek 论证）。
  - 三个 `summary()`（OMP `~1548`、Codex `~2130`、Claude `~2490`）加 `lastStderr: this.lastStderr ?? null`。
- **验证**：`repro-laststderr.mjs`——**三后端各测一遍**（fake 打一行无害 stderr 后正常完成 turn）：turn 成功后 `lastError===null`（不再被 stderr 污染），`lastStderr` 可见该行；再注入真错误确认 `lastError` 承载它。
- **验收**：`repro-halfdead`/`repro-waitfail` 仍能在 `lastError` 看到真错误；close code===0 保留前序真错误。

#### T5 · (P4) `clampText` 方向注释
- **根因**：`clampText`（`:433`）留尾，`buildSessionResult`（`:552`）留头。无 bug，是隐性脚枪。
- **修法**：仅加注释（`clampText` 处标"保留尾部——在途 tail"，截断处标"保留头部——成品预览"）。不改名，避免回归面（两评审都同意 comment-only）。
- **验证**：纯注释，靠 `git diff` 审查 + 全量 repro 回归。

#### T6 · (P5) Codex `model` 未 sanitize
- **根因**：Codex 构造 `this.model = options.model || null`（`~1616`）未过 `sanitizeAgentArg`；OMP（`~1088`）/Claude（`~2185`）都过了。
- **修法**：改为 `this.model = sanitizeAgentArg(options.model, "model")`（`sanitizeAgentArg` 对 null/undefined 返回 null，`|| null` 冗余可去——deepseek）。
- **验证**：`repro-codex-model-sanitize.mjs` 或直接断言 `sanitizeAgentArg` 拒非法、放行合法（`openai/gpt-5.2`）。
- **验收**：`e2e-real.mjs` 开 codex（空/合法 model）正常。

#### T-N2 · (N2) 入参运行时校验助手（**新增前置任务**，两评审都要求）
- **根因**：MCP 层不校验 tool schema——`handleMcp` 只查 args 是对象（`:3049`）。→ 后续每个新字段（`name`/`message_file`/`return_mode`/`schema`）都需运行时兜底，否则脏输入直达后端。
- **修法**：加一组纯函数助手：`assertString(v,name,{maxLen})`、`assertEnum(v,name,allowed)`、`assertPlainObject(v,name)`、`exactlyOne(obj,keys,name)`、`assertMaxBytes(str,name,cap)`。供 T7/T10/T11 复用（3 个消费者，非死代码）。
- **验证**：`repro-input-validation.mjs` 逐助手断言拒/放行。
- **验收**：不改动任何现有调用路径。

### Phase 2 — 采纳的功能

#### T7 · (A3) 会话别名 `name`
- **依赖**：T-N2。
- **修法**：`open_session` schema 加可选 `name`；`openSession()`（`:2557`）用 N2 校验 + sanitize；**唯一性 + 反冲突**：拒绝与任何现有 session `name` 重复，**且拒绝等于任何现有 session id**（否则 `getSession` 先按 id 解析会让该 name 永远寻址不到——codex 补的规则）；存 session；三 `summary()` 回显 `name`；`getSession()`（`:2605`）先按 id、再按唯一 name 解析，未知/歧义明确报错。
- **验证**：`e2e-real.mjs` 场景：带 name 开→回显→按 name 寻址→重名被拒→name==已存在 id 被拒。
- **验收**：不传 name 路径不变。

#### T9 · (A5) 派生 `health` 三态（不自动重试）
- **依赖**：T4（lastError 语义先干净）。
- **修法**：`summary()` 派生 `health`：`status∈{failed,closed}` 或 `proc?.exitCode!=null` → `dead`；活着但有真实 `lastError`（T4 后语义）→ `degraded`；否则 `healthy`。保留 `lastError`/`lastStderr` 诊断。**不实现对 stderr 串自动重试**（评审共识：太脆）。按全局契约，`buildSessionResult` 顶层也上提 `health`。
- **验证**：`repro-health.mjs`（fake）：正常→`healthy`；kill 后→`dead`；注入真错误→`degraded`；一条无害 stderr **不**把 `healthy` 打成 `degraded`（与 T4 联动）。**并断言 `wait().completed.health` 顶层可读**（顺带证明 T1 透传机制）。
- **验收**：既有 status 消费者不受影响（新增字段）。

#### T10 · (A2) `return_mode:"ref"` + `message_file`（含 N1 路径安全）
- **依赖**：T1、T-N2。
- **N1 路径安全助手 `resolveUnderCwd(cwd, p)`（两评审强制改形）**：
  - **canonicalize 两端**：`assertCwd` 只 `path.resolve`（`:322`）不 realpath，故 cwd 可能含符号链接/8.3 短名。助手内对 cwd 与目标都取 `fs.realpathSync.native`（目标须存在）。
  - **用 `path.relative` 判包含**，不用 `startsWith`：`const rel = path.relative(realCwd, realTarget); if (rel === "" ) ok(=cwd 本身，按需另判); if (rel.startsWith("..") || path.isAbsolute(rel)) reject;`。这一招同时解掉 `..` 越界、符号链接逃逸、Windows 大小写、8.3 短名（两评审一致推荐）。
  - Windows 额外大小写：realpath.native 会规范化盘符/大小写；仍以 `path.relative` 结果判定。
  - **校验后读/用 resolved（realTarget）路径**，不用原始入参（codex）。目标须是文件、非目录。
- **功能**：
  1. `open_session` 加 `return_mode`（enum `full|ref`，默认 `full`；本次不做生成式 `summary`），存 session。
  2. `buildSessionResult`/`result`/`send(wait)` 在 `return_mode==="ref"` 且本次未显式传 `max_chars` 时 `text:null`，只回 `charCount/byteCount/textRef`；**写 textRef 失败则退回全文内联**（守"必读不静默丢失"）。
  3. `send_message` 加 `message_file`：与 `message` **exactly-one-of**（N2 `exactlyOne`）；`resolveUnderCwd` 校验；`assertMaxBytes`（上限 1MB）；`readFileSync` 当消息体。
- **验证**：
  - `repro-pathsafe.mjs`（Windows 用例）：符号链接 cwd、逃逸 cwd 的符号链接文件、大小写差异、超限文件、目录路径、`message`/`message_file` 都传/都不传——分别按预期拒/放行。
  - `e2e-real.mjs`：`return_mode:"ref"` 的 turn 回 `text:null`+`textRef` 且文件内容完整（覆盖 `send(wait:true)`/`result`/`wait(all)`/`wait(any)`）；大 `message_file` 被后端消费；越界 `message_file` 被拒。
  - `return_mode:"ref"` 的 **textRef 写失败退回内联** 路径单测（deepseek C-T10）。
- **验收**：默认路径逐字不变。

#### T11 · (A1) Codex 原生 `schema` → `json` / `schemaError`
- **依赖**：T1、T-N2。
- **前提纠正**：非复用 Workflow（无此代码）；用 Codex app-server 原生 `outputSchema`——`turn/start` 的 `outputSchema: null` 在 **`:1968`**（已核实；官方 app-server 文档亦载 `outputSchema` 且仅作用于当前 turn）。
- **修法**：
  1. `send_message`/`open_session`(initial) schema 加可选 `schema`（object，N2 `assertPlainObject`）。
  2. **per-turn schema 状态（两评审强制）**：`sendMessage()`（`:2630`）把 `schema` 透传进 `session.send(msg,{...,schema})`；Codex `send()` 里 `outputSchema: options.schema ?? null` 且**存 `this._requestedSchema = options.schema ?? null`**（因为结果是事件驱动、在别处 build，`result()` 只带 `maxChars`——`:2692`）。turn 结束/新 turn 时复位该状态。
  3. `buildSessionResult`：若本轮请求了 schema，对最终文本 `JSON.parse`→顶层 `json`；解析失败→顶层 `schemaError:{error, rawText}`，**不抛**。
  4. **Codex failed-turn 路径（codex 补）**：schema 不满足可能表现为 app-server **failed turn**（经 `#settleTurn(err)` `:1916` 变 rejected/status failed），不一定是"畸形文本给 JSON.parse"。故 `schemaError` 契约要覆盖 failed-turn：捕获该失败、归一成 `schemaError` 返回而非纯抛。
  5. **校验策略**：无 JSON-Schema 校验库、无 package.json → **信任 Codex 的 `outputSchema` 服务端强制 + 仅 `JSON.parse`**，不自造校验器（codex D）。
  6. **OMP/Claude 传 schema**：在 `sendMessage()` 层（派发前）**明确拒绝**（`schema not supported for backend <x> yet`），不"忽略并告警"（codex：坏的机器可读契约）。
- **验证**（确定性优先，补 e2e）：
  - 单测 `buildSessionResult` 的 schema 分支：合法 JSON→`json`；畸形文本→`schemaError` 不抛（deepseek/codex 都要）。
  - 非阻塞 `send(schema)` 后 `wait()` 能带出 `json`（证明 per-turn 状态 + T1 透传）。
  - OMP/Claude 传 schema 被 `sendMessage` 拒（确定性、免真后端）。
  - `e2e-real.mjs`：codex 传小 schema（`{verdict,findings[]}`）happy path，`json` 已解析；`return_mode:"ref"`+schema 时先解析 json 再 null text（codex C-T11）。
- **验收**：不传 schema 的 codex 路径不变。

---

## 进度台账（每 task 完成后勾选 + 记 commit）
- [ ] T1 (N3) wait 字段透传 + 全局契约
- [ ] T2 (P3) doctor 超时（repro 用 OMP_BIN）
- [ ] T3 (P2) OMP 并发护栏
- [ ] T4 (P1) lastError 分通道（OMP/Codex/Claude 三处 stderr → lastStderr）
- [ ] T5 (P4) clampText 方向注释
- [ ] T6 (P5) codex model sanitize
- [ ] T-N2 入参校验助手（前置 T7/T10/T11）
- [ ] T7 (A3) name 别名（唯一 + 反冲突 id）
- [ ] T9 (A5) health 三态（+证明 wait 透传）
- [ ] T10 (A2) return_mode:ref + message_file（N1 用 path.relative+双端 realpath）
- [ ] T11 (A1) codex schema → json/schemaError（per-turn 状态 + failed-turn 路径）

> 已删除：~~T8 (A4) usage/token 计量~~——成本不予考虑（用户指示）。
