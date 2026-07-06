# Bug — claude 后端的 `contextUsage.tokens` 与 omp/codex 口径不一致，系统性虚高（跨 API 往返累加，非窗口占用）

**Date:** 2026-07-06
**Status:** **FIXED** 2026-07-06（根因二＝口径统计已修，见文末「Fix applied」。根因一＝真实 bootstrap 膨胀未改，留作独立可选项）
**Severity:** Minor（可观测性/契约 bug；无崩溃、无数据丢失。但会让 claude 会话在真实占用远低于阈值时就误报越过「关旧开新」400k 线，导致过早重开 + 三后端数值不可比）
**发现场景:** 一场 3 席圆桌审议（`agent-bridge-roundtable`），p1=omp/deepseek-v4-pro、p2=codex、p3=claude，各注入 panelist 角色、`access:read`、同一 `cwd`（一个 Next.js 项目）。

---

## Observed（现象）

同一个 round-0 任务（读几个源文件 + 产出一段 ~6k 字的评议），三席上报的 `contextUsage.tokens` 相差近一个数量级：

| 席位 | 后端 | round 0 | round 1 | `live` |
|---|---|---|---|---|
| p1 | omp / deepseek-v4-pro | **36,103** | 50,423 | `true` |
| p2 | codex | **88,360** | 114,228 | `false` |
| p3 | claude | **317,181** | **464,156** | `false` |

claude 用了 omp 约 **9×** 的上报上下文完成同一件事，且 round 1 越过了桥自己的 400k「关旧开新」阈值。直觉上不合理，遂追根因。

**一个直接反证锚点**：claude **单次** API 调用的最大 input 侧占用 = `cache_read 123,723 + cache_creation 22,372 + input 880 ≈ 147k`，但 round 0 上报 **317k**（≈ 单次峰值的 2.15×）。所以 317k 不可能是「当前窗口占用」，只能是跨多次调用的**累加**。

---

## Root cause（两层叠加，一真一测量口径）

### 根因一（真实膨胀）：claude 后端 = 一个「完整 Claude Code」，继承了宿主环境的重型 bootstrap

omp/codex 是精简 RPC 后端；claude 后端在**同一 `cwd`** 里拉起一个真正的 Claude Code CLI，于是把宿主 Claude Code 会话的整套启动上下文全继承：SessionStart 钩子（把 `superpowers:using-superpowers` skill 正文注入）、约 60 个 skill 的完整目录、全局+项目两份 `CLAUDE.md`、memory、以及全部工具/MCP schema。

**日志实证**（`grep -a` 三个后端的原始会话日志 `~/.agent-bridge/logs/<mcp>/<session>.log`）：

| 标记 | claude | codex | omp |
|---|---|---|---|
| `You have superpowers`（SessionStart 钩子正文） | 1 | 0 | 0 |
| `SUBAGENT-STOP`（using-superpowers skill 正文被注入） | 1 | 0 | 0 |
| `ui-ux-pro-max` / `frontend-slides`（全量 skills 目录） | 4 / 4 | 0 / 0 | 0 / 1 |

claude 单次调用真实占用峰值 ≈147k，而 omp 36k、codex 88k——**光 bootstrap 就让 claude 的真实上下文是 omp 的 ~3-4×**。这一层是真实的，不是测量假象。

### 根因二（测量口径）：claude 的 `contextUsage()` 取「整轮 `modelUsage` 聚合」，而 omp/codex 取「窗口占用/末次快照」——三者不可比

三个后端的 `contextUsage()` 算法根本不同（`scripts/agent-bridge.mjs`）：

| 后端 | 代码位置 | 取值 | 语义 |
|---|---|---|---|
| **omp** | `contextUsage()` @ **1893-1896** | `sessionState.contextUsage.tokens`（`get_state` 实时读数），`live:true` | **真·当前窗口占用** |
| **codex** | `contextUsage()` @ **2557-2560** | `tokenUsage.last.inputTokens`（上一轮末次快照），`live:false` | ≈ 末次调用的 input 占用 |
| **claude** | `contextUsage()` @ **2966-2979** | `result.modelUsage` 主模型条目的 `inputTokens + cacheReadInputTokens + cacheCreationInputTokens`，`live:false` | **一整轮里所有 API 往返的聚合累加** |

关键：`result.modelUsage`（在 **2832-2833** 处从 result 捕获：`if (msg.modelUsage) this.modelUsage = msg.modelUsage;`）是 Claude Code 对**该轮所有内部 API 调用**的**逐模型聚合**。而一个 agentic turn（读文件→思考→再读→产出）会打多次 API，**每次都把缓存里的基础上下文重新读一遍**（`cache_read`）。把这些 `cacheReadInputTokens` 全加起来，就等于把基础上下文乘上了往返次数。

代码注释（2963-2964）写的意图是「Current context = input-side tokens (fresh input + cache read + cache creation)」——这个等式**对单次 API 调用成立，但 `modelUsage` 是整轮聚合**，于是被 tool-loop 的往返次数放大。omp（实时 get_state）和 codex（末次 inputTokens 快照）都没有这层乘法，所以三者不可比。

**数量级印证**（claude 日志逐字段求和，r0+r1 全程）：`cache_read_input_tokens` 累计 ≈498k、`cache_creation` ≈89k；单次 `cache_read` 分别为 54,270 / 123,723 / 68,097——每次调用都在重读一份大缓存上下文，`modelUsage` 把它们聚合，于是 r0 报到 317k、r1 报到 464k。

> **诚实边界**：无法从日志字节级精确重构出 317k——因为 `modelUsage` 聚合的内部 API 调用数量多于日志里单独露出的 per-message usage 记录（日志只有 4 条 `input_tokens` 记录，但 `modelUsage` 聚合的调用更多）。但「单次峰值 147k < 上报 317k」这一条已足以判定该值是**跨调用累加、非窗口占用**。

---

## Impact（影响）

- 本次圆桌**无实质损害**：claude 产出完整未截断；464k 越过 400k 阈值恰好触发了主席「点名提示 + 不再给该席派活」的护栏——护栏按预期工作。
- 但该数值**误导**：让 claude 显得比真实情况更接近 context-rot（虚高 ~2×）。照字面信就会**过早**重开 claude 会话。根因一让 claude 真实占用本就偏高，根因二又在其上再乘一层往返数——两者叠加放大了「9× 差距」的观感。
- 本质是**三后端 contextUsage 语义不统一**，破坏了「用同一阈值判所有后端」这个前提。

---

## Fix options（供维护者取舍，本文档不含改动）

1. **根因二（口径对齐，优先）**：把 claude 的 `contextUsage()` 改为反映**单次调用的窗口占用**，而非整轮 `modelUsage` 聚合。可选路径：
   - 若 Claude Code 的 result 或 stream 里能拿到「末次 assistant API 调用」的 usage，取那一次的 `input + cache_read + cache_creation`（与 codex 的「末次 inputTokens 快照」语义对齐）；
   - 或改从流式 assistant message 的 per-call `usage` 里取**最大单次** input 侧值（峰值占用），而非求和。
   - 目标：三后端的 `contextUsage.tokens` 都表示「当前上下文窗口占用」，可用同一 400k 阈值比较。
2. **根因一（真实膨胀，可选）**：若希望委托 claude worker 更轻，拉起 claude 时用「不继承宿主 SessionStart 钩子 / 精简 settings」的方式启动（委托 worker 本不需要 superpowers 钩子 + 全 skills 目录 + 项目 CLAUDE.md）。这能同时减小真实占用与日志体积。

## Repro（复现指引）

1. 用 `agent_bridge_open_session({agent:"claude", cwd:<一个带 .claude/settings.json SessionStart 钩子 + CLAUDE.md 的项目>, access:"read"})` 开一个 claude 会话；同 `cwd` 各开一个 omp、codex 会话。
2. 给三者发同一个「读几个文件 + 写一段分析」的 prompt。
3. 收口后比较三者 `wait`/`status` 返回的 `contextUsage.tokens`：claude 会显著高于另两者。
4. `grep -a 'You have superpowers|SUBAGENT-STOP|ui-ux-pro-max'` claude 的会话 `.log`（根因一实证）；`grep -aoE '"cache_read_input_tokens":[0-9]+'` 求和并对比单次峰值 vs 上报值（根因二实证）。
5. 交叉对读 `scripts/agent-bridge.mjs` 的 `contextUsage()` 三处实现（1893 / 2557 / 2966）确认口径差异。

---

## Fix applied（2026-07-06，根因二＝口径统计）

**改法（追根因，非打补丁）：** claude 的 `contextUsage()` 不再读整轮 `modelUsage` 聚合，改读**末次 assistant API 调用的 per-call input 侧**（`input_tokens + cache_read_input_tokens + cache_creation_input_tokens` of ONE call）。这与 codex 的「末次 inputTokens 快照」、omp 的「当前占用」语义对齐——三后端 `contextUsage.tokens` 现在都表示「当前上下文窗口占用」，可用同一 400k 阈值比较。

**为什么取「末次调用」而不是「求和」或「峰值」：**
- **求和**（旧行为）= 基础上下文 × API 往返次数——正是本 bug。
- **末次单次调用** = 会带入下一轮的当前上下文，天然无往返乘法。
- 取**末次**而非**峰值**：若 turn 内发生 auto-compaction，末次调用的 input 会**低于**压缩前峰值——取末次才反映压缩后的真实占用，取峰值会报过时的高值。

**为什么数据源改用流式 `assistant` 消息（`scripts/agent-bridge.mjs` `#handleLine`）：** 实证（2026-07-06，真实 claude stream-json）——每条 `assistant` 消息的 `message.usage` 携带**那一次 API 调用**的 per-call usage；顶层 assistant 流**只含主 agent**（subagent 内部轮次不作为顶层 assistant 流出），故结构上天然免除旧代码靠 `contextWindow` 排除 subagent 的那套逻辑。`result.usage.iterations` 语义模糊（3 次调用却 count=1）遂弃用；顶层 `result.usage` / `modelUsage` 均为整轮聚合，弃用。

**实证锚点：** 一个平凡 3 次调用 turn，`result.usage`/`modelUsage` 聚合报 **100,374**，末次单次调用 input 侧 = **33,663**（3× 虚高，倍数＝往返次数）。修复后经真实桥端到端跑同一 prompt：`contextUsage.tokens = 33,843`（单次口径），非 ~100k。

**改动文件：**
- `scripts/agent-bridge.mjs`：新增 `lastCallContextTokens`（构造器 + `#beginTurn` 每轮重置）；`#handleLine` 的 assistant 分支捕获末次 per-call input 侧；`contextUsage()` 改读它。**捕获受闸门保护**（`this.turn && pendingAbortedResults===0 && !interrupting`）——与 `#handleResult` 的 usage 捕获同一「只取存活且保留的 turn」不变量，使被 abort 的 turn 的迟到 assistant（此时 pending>0）不会泄漏进后续 turn。**删除**了 `ClaudeCodeSession` 中已成只写死状态的 `tokenUsage`/`modelUsage`（原始 result 已 verbatim 落日志）。
- `docs/repro-mcp-hang/fake-claude.mjs` + `repro-context-usage.mjs`：ctx 桩改吐真实形状（per-call assistant usage）；新增回归护栏（`ctxturn` 断言取末次 41002 而非聚合 100004；新 `ctxlast` 断言 mid-turn 压缩后取末次 45000 而非峰值 60000/和 135000）。新增 `abortusage` 桩模式。
- `docs/repro-mcp-hang/probe-claude-abort-usage-gate.mjs`（新）：驱动「abort 后迟到 assistant 带 usage（99000）在 pending>0 时到达」这条泄漏路径,断言被闸门跳过 → B 后 `contextUsage` null。已验证去掉闸门该断言即 FAIL（非空测试）。
- `probe-claude-abort-fallback.mjs` / `e2e-real.mjs`：更新注释与断言口径（不再引用 modelUsage 选取逻辑）。

**评审：** codex（xhigh，引擎≠实施者）独立评审给 NEEDS_FIXES，命中两点：①assistant 捕获未与 result 捕获同受闸门保护（Medium）②`modelUsage`/`tokenUsage` 成死状态（Low）。二者均按根因修复（非打补丁），并补测试；注释口径亦按其 #2 收紧。

**验证：** `repro-context-usage` 7/7；`probe-claude-abort-usage-gate` 7/7（含去闸门即 FAIL 的反证）；`probe-claude-abort-fallback` 9/9、`probe-claude-turn` 6/6、`probe-claude-abort` 4/4；**全后端 `e2e-real` 29/29**（claude 现读单次口径）；真实 claude 端到端 32-34k（单次带内，旧聚合口径为 ~100k）。

**未做（有意）：** 根因一（真实 bootstrap 膨胀＝claude worker 继承宿主 SessionStart 钩子 + 全 skills 目录 + 项目 CLAUDE.md）未改——它是真实占用而非测量假象，且涉及改 worker 启动方式（继承面），风险与范围独立于「口径统计」，留作单独可选项（见上「Fix options 2」）。
