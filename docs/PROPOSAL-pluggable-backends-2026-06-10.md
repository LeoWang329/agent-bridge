# 改造方案 — 让后端（CLI 对接）真正可插拔 (2026-06-10)

> 评估当前"对接不同 CLI"的架构，回答"新增一个 CLI 工作量大不大、风险高不高、现在是不是可随意拔插的 adapter"，并给出一个**按比例、可落地、不过度设计**的重构方案。
>
> 本文由 **Codex + DeepSeek-v4-pro 双路独立只读评审**产出，主 agent（Claude）逐条**核验了其中的事实声明**（line 号、`instanceof` 点、settled 逻辑、cleanup matcher）后综合裁决。所有 `scripts/agent-bridge.mjs:NNN` 引用均已对照代码确认。
>
> 不改代码，仅记录方案。当前架构权威说明见 [README.md](../README.md) 与 [DEVELOPMENT.md](DEVELOPMENT.md)；演进脉络见 [ARCHITECTURE.md](ARCHITECTURE.md)。

---

## 一句话结论

**现在不是"每个 CLI 包一个 adapter、注册即可随意拔插"的架构**，而是**两套硬编码的 session 实现（`OmpRpcSession` / `CodexAppServerSession`），靠 duck typing 接到同一组 MCP tools**。新增第三个 CLI 的**工作量中等**（主要是写一个 ~450–650 行的 adapter，这部分省不掉），但**当前风险偏高**——风险不在代码量，而在一堆**隐式状态契约**和**散落的硬编码分发点**。做完本文的小重构（净改动 ~40 行、新增 ~15 行、不加新文件/新依赖）后，"新增 CLI"的风险可从**中高**降到**中低**。

---

## 一、现状架构剖析（已核验）

### 1.1 `AGENTS` 是元数据表，不是工厂注册表

`scripts/agent-bridge.mjs:63` 的 `AGENTS` 只存三条信息：

```js
const AGENTS = {
  omp:   { label: "Oh My Pi", env: "OMP_BIN",   bin: "omp"   },
  codex: { label: "Codex",    env: "CODEX_BIN", bin: "codex" },
};
```

它不含 session 类引用、不含能力标志、不含 cleanup 角色 matcher、不驱动任何实例化。实际只被三处读：`agentBin()`（解析 bin 路径）、`assertAgent()`（`scripts/agent-bridge.mjs:268` 存在性校验）、`doctor()`（`scripts/agent-bridge.mjs:2305` 遍历做诊断）。**它是一张静态配置表。**

### 1.2 实例化分发是硬编码三元，else 分支会"静默落 Codex"

`scripts/agent-bridge.mjs:2074`：

```js
const session = params.agent === "omp" ? new OmpRpcSession(params) : new CodexAppServerSession(params);
```

任何**非 `"omp"`** 的值都会被实例化成 Codex。前面有 `assertAgent()` 挡一道，但**守卫与分发是两个独立位置**——一旦哪次重构把校验挪走/绕过，typo（`"ompp"`、`"codx"`）会**静默**拿到一个 Codex 会话而不报错。这是最隐蔽的一类 bug：后端能跑，只是角色全错。

### 1.3 enum 硬编码，与注册表手动同步

`scripts/agent-bridge.mjs:92`：`agent: { type: "string", enum: ["omp", "codex"], ... }`。与 `AGENTS` 的 key 集靠人脑同步，新增后端必须同时改两处。

### 1.4 两个 session 类零继承、无显式接口

`OmpRpcSession`（~500 行，`scripts/agent-bridge.mjs:993`）与 `CodexAppServerSession`（~540 行，`scripts/agent-bridge.mjs:1492`）**无共享基类、无接口契约**。契约完全是隐式的：

- **方法**：`start / send / result / abort / close / summary`
- **字段**：`status / isStreaming / lastAssistantText / events / proc / logFile / answerFile / pidFile / currentTurnId / lastTurnId / turnStartedAt / turnEndedAt / …`

**已经存在的漂移（核验属实）：**

| 漂移点 | 证据 | 影响 |
|---|---|---|
| `result()` 一个 async 一个 sync | OMP `async result()` `:1379`；Codex sync `result()` `:1950`；调用侧统一 `await` `:2150` | 当前无害（`await` 非 Promise 安全），但任何依赖"result 是否异步"的代码会分叉 |
| `state()` / `waitIdle()` 仅 OMP 有 | — | `status()` 必须 `instanceof` 特判才知道要不要刷新 |
| settled 判定依赖后端私有字段 | `sessionSettled()` `:2156`：OMP `status==="idle" && !turnInFlight`（`:2167`），Codex `status==="idle" && !turn`（`:2169`） | 写错 → `wait` 永久挂死或提前返回空结果（即 v0.8.1 修的那类 bug） |
| `summary().agentSpecific` 内容各异 | OMP 给 `{sessionId, messageCount, …}`，Codex 给 `{threadId, turnCount}` | 顶层 shape 已统一，但差异数据靠各类自觉填 |

### 1.5 散落的 `instanceof OmpRpcSession`（3 处，已核验）

| 位置 | 作用 |
|---|---|
| `scripts/agent-bridge.mjs:2130` | `status()`：决定是否调 `state()` 刷新实时状态 |
| `scripts/agent-bridge.mjs:2159` | `sessionSettled()`：决定用哪套 settled 判定 |
| `scripts/agent-bridge.mjs:2223` | `waitSessions()` 轮询：决定是否调 `state()` |

每加一个需要"特殊对待"的后端，这三处都要改；漏改任一处就是 bug。

### 1.6 cleanup 的 role matcher 不是注册表驱动，且是**安全边界**

`roleMatchesCommand()`（`scripts/agent-bridge.mjs:688`）只认识两种角色：

```js
if (role === "omp-rpc")        return /\bomp\b/.test(command) && /--mode\s+rpc|…/.test(command);
if (role === "codex-app-server") return /\bcodex\b/.test(command) && /\bapp-server\b/.test(command);
```

孤儿进程回收（`classifyChild()` `:672`）靠它确认身份再决定杀不杀。这不是"可用性细节"而是**安全边界**：新后端漏写 matcher → 泄漏孤儿后端进程；matcher 写太宽 → orphan cleanup 时可能误伤不属于 bridge 的进程。

### 1.7 doctor 硬编码 `--version` 探测

`doctor()` `:2313` 对每个后端跑 `spawnPlan(bin, ["--version"])`。新 CLI 若不支持 `--version`，诊断会误报不可用。

### 1.8 共享基础设施（已有，做得不错）

两类都复用了模块级工具函数：`makeId / assertCwd / childEnv / spawnPlan / appendLog / pushEvent / setSessionStatus / lastTurnOf / buildSessionResult / pidRecordPath·writePidRecord·removePidRecord / clampText / stripAnsi / withTimeout`。**重复的主要是**：两个构造器各自手抄 ~30 行相同字段初始化、spawn/stdin/stderr/close 处理骨架、pid record、summary 顶层 shape、close 终止逻辑。

---

## 二、新增一个 CLI：工作量与风险

### 2.1 必须改的编辑点清单

| # | 位置 | 改动 |
|---|---|---|
| 1 | `AGENTS` `:63` | 加一条 `{ label, env, bin }` |
| 2 | tool schema enum `:92` | 往 `enum` 数组加字符串（+ 描述文案） |
| 3 | `assertAgent()` `:268` | 错误文案 |
| 4 | **新 Session 类** | 写 ~450–650 行：生命周期、协议解析、`send/result/abort/close/summary` |
| 5 | `openSession()` 三元 `:2074` | 加分支（否则非 omp 静默落 Codex） |
| 6 | `status()` `:2130` | 若新后端需实时状态刷新，加 `instanceof` 分支 |
| 7 | `sessionSettled()` `:2159` | 加新后端的 settled 判定 |
| 8 | `waitSessions()` `:2223` | 若需轮询，加 `instanceof` 分支 |
| 9 | `roleMatchesCommand()` `:688` + pid record 的 `role` | 加命令特征 matcher（**安全边界**） |
| 10 | `doctor()` `:2313` | 若新 CLI 不支持 `--version`，加 per-backend 探测 |
| 11 | README / DEVELOPMENT / SKILL.md | 文案同步，否则客户端和人只看到 OMP/Codex |

### 2.2 评级

- **工作量：中**。新 adapter ~450–650 行（前提是新 CLI 有稳定的持久 JSONL/JSON-RPC 协议；若只有 TUI 或 one-shot 输出会升到"大"）+ 散点 ~15–20 行 + 文档。相对当前 2658 行约 17–25% 增量。
- **风险：中高**。理由不是代码量，而是：
  1. **隐式契约无强制力** → 漏实现方法/漏初始化字段 = 运行时 crash 或 `undefined`。
  2. **settled 逻辑微妙** → 写错直接复现 v0.8.1 的死等/假完成（僵尸 server 的关键机制）。
  3. **3 处 `instanceof` 易漏改** → 状态过时 / 永不 settled。
  4. **三元 else 静默落 Codex** → 角色错配的隐蔽 bug。
  5. **cleanup matcher 是安全边界** → 漏写泄漏孤儿、写宽误杀。

> **给用户问题的直接回答**：写 adapter 这部分（~500 行）是**省不掉的**——每个 CLI 协议真的不同。重构**不会**让"新增 CLI"变成零成本；它消除的是上面 5 条里 **2–5 的"散落编辑 + 静默失败"风险**，把一次中高风险的改动变成中低风险。

---

## 三、改造方案（按比例、分步、可落地）

> **原则：不过度设计。** 仅 2–3 个后端，**不要**做插件自动发现 / 动态 import / 完整 capability negotiation / 引入 TypeScript。目标只有三个：① 消除硬编码散点（dispatch、enum、`instanceof`、cleanup matcher、doctor 探测都走注册表）；② 把隐式契约显式化（文档 + 把 settled/刷新封装成方法）；③ 让"新增后端 = 加一条注册表项 + 实现一个文档化的类"。

### Step 1 —— 把行为差异封装成 session 方法（消除全部 `instanceof`）

给两个类各加两个方法，**把后端私有知识留在后端类内**（优于把 `turnInFlight`/`turn` 暴露进注册表闭包）：

- `isSettled()` —— 返回"当前 turn 是否已结束、可收结果"。OMP：`this.status==="idle" && !this.turnInFlight`；Codex：`this.status==="idle" && !this.turn`。
- `refreshStatus()` —— `status()`/`waitSessions()` 调它来刷新实时状态。OMP：`await this.state()`；Codex：**默认 no-op**（事件驱动，无需轮询）。

然后把 `sessionSettled(session)` 改成 `session.isSettled()`，把 `:2130` / `:2223` 的 `instanceof … && state()` 改成 `await session.refreshStatus()`。**3 处 `instanceof` 全部消失**，且新后端的 settled/刷新逻辑只写在自己类里。

### Step 2 —— 注册表驱动实例化、enum、cleanup、doctor

**注意模块加载顺序约束（已核验的真实陷阱）**：`const AGENTS`（`:63`）在模块加载到该行时求值，而类声明 `OmpRpcSession`（`:993`）/ `CodexAppServerSession`（`:1492`）此时处于 TDZ，**不能**在 `:63` 的对象字面量里写 `Session: OmpRpcSession`（会 `ReferenceError`）。且 `TOOLS`（`:84`）、`agentBin`、`doctor` 都需要 `AGENTS` 早就绪。

**正确解法 = 早定义薄注册表 + 类绑定后置**，而不是把 `AGENTS` 整体下移：

```js
// 仍在 :63 —— 元数据/键，供 TOOLS enum、agentBin、doctor、assertAgent 早期使用
const AGENTS = {
  omp:   { label: "Oh My Pi", env: "OMP_BIN",   bin: "omp",   role: "omp-rpc",         versionArgs: ["--version"] },
  codex: { label: "Codex",    env: "CODEX_BIN", bin: "codex", role: "codex-app-server", versionArgs: ["--version"] },
};

// 在两个类定义之后（:1492 之后、openSession 之前）再绑定类引用：
AGENTS.omp.Session   = OmpRpcSession;
AGENTS.codex.Session = CodexAppServerSession;
```

随后：

- **`openSession` `:2074`** → `new AGENTS[params.agent].Session(params)`（三元消失；未知 agent 由 `assertAgent` 自然拦截，不再静默落 Codex）。
- **TOOLS enum `:92`** → `enum: Object.keys(AGENTS)`（单点同步）。
- **`roleMatchesCommand` / pid record 的 `role`** → 从 `AGENTS[agent].role` 取；matcher 表也按 role 注册（保持显式正则，**安全边界不要弄玄**）。
- **`doctor` `:2313`** → 用 `AGENTS[agent].versionArgs`（新 CLI 不支持 `--version` 时可覆盖）。

### Step 3 —— 文档化隐式接口

在两个类上方加一段 ~15 行 JSDoc，列出"新后端必须实现的方法 + 必须设置的字段"，并**特别标注 settled 的微妙性**（不能只看 `status`，必须结合"当前 turn 是否还在飞"的后端内部旗标，否则回到 v0.8.1 死等）。这不是运行时强制，但给下一个维护者一张 checklist。

### Step 4 —— 收口：`result()` 签名统一

把 Codex 的 `result()` 也声明为 `async`（内部无 `await` 也无妨），消除 async/sync 漂移，成本为零。

### Step 5（可选，低优先）—— 共享字段初始化 helper

~30 行重复的构造器赋值可抽成 `initSessionFields(self, agentName, options)` **函数**（不是基类）。**当前不强烈推荐**：省 30 行但要全程对照；若做，用函数而非继承，避免引入类继承的概念负载。

### 迁移顺序（每步都能用现有 harness 回归）

1. 先加 `isSettled()` / `refreshStatus()`（Codex 的 `refreshStatus` 为 no-op），**不改调用方**——行为不变。
2. 把 `sessionSettled()`、`:2130`、`:2223` 改成调新方法，删 `instanceof`。
3. 后置绑定 `AGENTS.*.Session`，`openSession` 改注册表驱动。
4. enum 改 `Object.keys(AGENTS)`；`roleMatchesCommand` / `doctor` 改读注册表。
5. Codex `result()` 加 `async`；补接口文档注释。
6. 每步后跑既有复现/端到端：`docs/repro-mcp-hang/`（`repro-kill` / `repro-pipebreak` / `repro-parent-death` / `repro-watchdog-disarm` / `repro-turnstate` / `repro-halfdead` …）+ OMP/Codex smoke。
7. 真正接新后端时，才新增其 adapter 类 + 一条注册表项 + 一条 role matcher。

**净改动估计**：~40 行改 + ~15 行加（文档注释），0 新文件、0 新依赖、0 新抽象基类。

---

## 四、不该做的事（边界）

- ❌ **为省 30 行赋值提取 `BackendSession` 基类**：两后端的 `start/send/result/abort/close` 实现本质不同（JSONL vs JSON-RPC、轮询 vs 事件驱动、turn promise vs turnInFlight flag），可共享的只有字段赋值。继承的概念负载 > 收益。
- ❌ **引入 TypeScript / 接口文件**：与"纯 JS 单文件脚本"的现存哲学冲突，等于加构建步骤。
- ❌ **插件自动发现 / 动态加载**：2–3 个后端不值得。
- ❌ **给 `status()`/`waitSessions()` 做完全通用适配层**：每个后端的 settled 机制本质不同，强求统一反增脆弱。用"后端自己的 `isSettled()` 方法"做适配是最轻量解。

---

## 五、最容易被忽略的风险点

1. **三元 else 静默实例化是"现在就有"的时间炸弹**（`:2074`）：不是"加第三后端才有"。`assertAgent` 一旦被重构绕过，typo 会拿到 Codex 会话而不报错。Step 2 的注册表驱动顺带根治。
2. **settled 逻辑不通用，写错 = `wait` 永久挂死 / 假完成**（`:2156`）：这正是 v0.8.1 调查里僵尸 server 的核心机制。新后端的 `isSettled()` 必须与它自己的生命周期状态机完全一致——只看 `status==="idle"` 不够，必须结合"当前 turn 是否还在飞"。**接口文档必须把这条写死。**
3. **cleanup role matcher 是安全边界，不是可用性细节**（`:688`）：新后端漏写 → 孤儿进程泄漏；写太宽 → 可能在 orphan cleanup 时误杀无关进程。

---

## 六、双评分歧与把关结论（透明记录）

- **高度一致**：两评对"非可插拔 / 三元 else 隐患 / 3 处 `instanceof` / settled 后端私有 / cleanup matcher / 不要过度设计"判断完全吻合；事实声明经主 agent 逐条核验全部属实。
- **互补**：Codex 侧更强调 cleanup matcher 的**安全边界**性质与"每步可回归"的迁移顺序；DeepSeek 侧给出完整 10 点编辑清单、把 settled 写错=复现 v0.8.1、以及具体注册表形状与"不该做"清单。
- **主 agent 裁决（与单评不同处）**：
  1. **封装为方法（`isSettled()`/`refreshStatus()`）优于"注册表里写 settled 闭包"**——后者会把后端私有字段（`turnInFlight`/`turn`）泄漏进注册表，破坏封装；方法封装同样能消除 `instanceof`，且新后端逻辑内聚在自己类里。
  2. **模块加载顺序**：DeepSeek 提议"把 AGENTS 移到类之后或用 lazy getter"，但 `AGENTS` 整体下移会破坏更早求值的 `TOOLS` enum / `agentBin` / `doctor`。正确解是**早定义薄注册表（键+元数据）+ 类引用后置绑定**（见 Step 2），二者兼得。
