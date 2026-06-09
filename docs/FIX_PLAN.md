# Agent Bridge — 消费方反馈第二轮 · 修复计划（待评审）

> 来源：一位真实编排方使用者（用 agent-bridge 给 omp/codex/deepseek 派活做交叉审核）反馈的 6 条摩擦点。
> 本文先做**第一性原理评估**（哪些是真缺口、哪些已被现有能力覆盖），再给出修复设计。
> 待 codex + deepseek 交叉评审后定稿、再实现。基线版本 0.7.0。

---

## 评估结论

逐条对照 `scripts/agent-bridge.mjs` 现状：

| # | 反馈 | 结论 | 关键事实 |
|---|---|---|---|
| 1 | spawn 出的进程 OS 层不可区分 | **修** | `start()` 用 `env: process.env` 起子进程（L830 / L1179），**无任何注入标记**。外部观察者无法把一个 `codex app-server` / `omp --mode rpc` 归属到本桥。 |
| 2 | 长 `wait` 期间零进度可见 | **修（收敛范围）** | 积木已在：推荐用法是「非阻塞 send + 短 `timeout_ms` 的 `wait`」，`status.recentEvents` 给生命周期、`result` 在途返回累积的 `lastAssistantText`。**真正缺的是**：`wait` 超时只回 `pending: string[]`（裸 id），不可行动；消费方因此干等 4 分钟。 |
| 3 | model 不校验、不可列举 | **部分修（先调研）** | omp 走 `--model`（仅 `sanitizeAgentArg` 字符集校验），codex 走 `thread/start`/`turn/start`。非法 model → 后端在 start 时报错并冒泡，但信息不清晰。`list_models` 取决于后端是否提供枚举，**未验证**。 |
| 4 | 结果无 token/成本 | **跳过**（用户指定） | 备注：codex 的 `thread/tokenUsage/updated`（`this.tokenUsage`）与 omp `get_state.data.contextUsage` 内部已有，将来接入成本极低。 |
| 5 | 缺「关掉我全部会话」兜底 | **修** | `close_session` 只接受单个 `session_id`；崩溃/忘关会留后端进程。 |
| 6 | 非阻塞 send + 单独 wait 两步舞 | **不改代码（文档）** | **已可单步**：`send_message(wait:true)` 与 `open_session(initial_prompt, wait:true)` 直接 open+send+wait。消费方未发现该入参。补 SKILL/README 即可。 |

> 优先级：**#1、#5（低成本高收益、零/小 schema 影响）> #2（中等、收敛为轮询友好增强）> #3（先调研后决策）**。#4 跳过，#6 文档。

---

## 修复 #1 · 进程可识别（注入 env 标记）

**根因**：子进程继承父 env，但桥没打任何自己的标记。`roleMatchesCommand`（L535）只能靠命令行副签名（`omp` + `--mode rpc` / `codex` + `app-server`）区分——这正是消费方抱怨的「靠副签名硬区分」，且对 PID 复用不鲁棒。

**改动**：两个 `start()` 的 `spawn(... env ...)` 由 `process.env` 改为注入标记：

```js
env: {
  ...process.env,
  AGENT_BRIDGE_SESSION_ID: this.id,      // 例 codex-xxxx / omp-xxxx
  AGENT_BRIDGE_OWNER_PID: String(process.pid),
  AGENT_BRIDGE_AGENT: this.agent,        // "omp" | "codex"
},
```

**收益与诚实边界**：
- Linux/macOS：外部可经 `/proc/<pid>/environ` 或 `ps e` 可靠读到标记，把任意 omp/codex 进程归属到本桥及具体会话——直接消掉「靠 `--listen stdio` 等副签名硬区分」。
- Windows：env **不**进默认 CIM `CommandLine` 视图，但仍注入，能被读进程 env 的工具（Process Explorer 等）看到。
- 次要收益：cleanup 的 PID 复用安全在 Linux 上可顺带加固（confirm 记录的 child 仍带本会话 `AGENT_BRIDGE_SESSION_ID` 才 kill）——**本轮不做**，避免 scope 蔓延，仅留 TODO。

**「PID record 可通过工具查询」其实已基本满足**：`agent_bridge_status`（无 `session_id`）已列出本进程全部会话的 `pid`/`agent`/`cwd`；`~/.agent-bridge/pids/<id>.json` 落盘记录含 `ownerPid`/`command`。env 标记补的是**跨工具、OS 层**这一段。无需新增查询工具。

**成本**：每处 ~4 行，零 schema 影响，子进程拿到全部父 env + 标记，无回归面。

---

## 修复 #5 · 批量关闭（close_session 省略 id = 关全部）

**设计**：复用 `status` 的语义——`agent_bridge_close_session` 省略 `session_id` 时关闭**本进程**全部会话。不新增工具。

- `inputSchema`：把 `session_id` 从 `required` 移除（保持 `additionalProperties:false`）。
- `closeSession(sessionId)`：`sessionId` 为空时遍历 `sessions` 全关，返回 `{ closedAll: true, count, sessionIds:[...] }`；单 id 行为不变（仍返回 `{ closed:true, sessionId }`）。
- `callTool` 透传 `args?.session_id`。

```js
function closeSession(sessionId) {
  if (!sessionId) {
    const ids = [...sessions.keys()];
    for (const id of ids) { try { closeSession(id); } catch {} }   // 复用单关路径(含 pruneLogs)
    return { closedAll: true, count: ids.length, sessionIds: ids };
  }
  // ……既有单会话逻辑不变……
}
```

**风险**：误调（无 id）会清空全部——但这与 `status` 无 id「列全部」对称，且正是消费方要的兜底；schema 描述里写清。**附带**：`cleanup` CLI 已能回收 owner 已死的孤儿，本项解决的是**同一活进程内**的「忘关/中途崩」。

**成本**：小；单 id 路径零回归。

---

## 修复 #2 · 长 wait 进度可见（轮询友好增强，非流式）

**架构约束（先讲清，避免方向漂移）**：本 server 不实现 MCP `notifications/progress`，编排模型消费的是**工具返回值**而非通知。所以「单次 `wait` 调用中途流式回吐」与现架构不符。正确方向是**让超时返回可行动**，配合既有「短 `timeout_ms` 反复 wait」用法。

**改动 A（核心）**：`waitSessions` 超时分支，给每个 pending 会话带**轻量进度快照**（全部复用既有累积态，无新增管线）：

```js
const snapshot = id => {
  const s = sessions.get(id);
  const partial = s?.lastAssistantText || "";        // 两后端流式累积的实时前沿
  return {
    sessionId: id,
    status: s?.status ?? "closed",
    updatedAt: s?.updatedAt ?? null,
    charCount: partial.length,
    tail: partial.slice(-(parseNumber(params.tail_chars, 240))), // 末 N 字 = 当前在做什么
    lastEvent: slimEvents(s?.events ?? [], 1)[0] ?? null,         // 最近一条生命周期(工具/turn)
  };
};
// 超时返回新增 pendingSnapshots（保留 pending: string[] 不破坏既有形状）
return { mode, timedOut: true, settled: ..., pending: pendingIds(), pendingSnapshots: pendingIds().map(snapshot) };
```

- `lastAssistantText` 对 omp（`message_update` text_delta，L960）和 codex（`item/agentMessage/delta`，L1376）都是**实时累积的部分文本**，取末尾即「此刻在吐什么」。
- 用 **tail**（末 N 字）而非 head：进度看的是前沿；最终答案的 `result` 仍保持 head 截断（要答案开头），两者语义分离、互不影响。
- 新增可选入参 `tail_chars`（默认 240）。

**改动 B（兼容）**：`pending` 保持 `string[]`，**新增** `pendingSnapshots`，加性变更不破坏 P2/P3 既定形状。

**改动 C（文档）**：SKILL/README 把「短 `timeout_ms` + 读 `pendingSnapshots` + 再 wait」显式写成推荐进度模式——消费方这次是用一个超长 timeout 干等，并非能力不存在。

**成本**：集中在 `waitSessions`，中等；不碰后端协议。

---

## 修复 #3 · model 校验/枚举（先调研，分级落地）

**现状**：无语义校验。非法 model → omp 在 spawn/ready 期失败、codex 在 `thread/start`/`turn/start` 失败，错误会冒泡但不点名「是 model 的锅」。`list_models` 取决于后端 CLI 是否提供枚举（**未验证**）。

**分级方案（按确定性排序）**：
1. **保底（必做、零依赖）**：`open_session` 因 model 被后端拒绝而失败时，错误信息显式带上 `agent` + `model`，给「可能是 model 名/ provider 前缀错误，用 doctor 核对」的提示。让「打错 provider 前缀」从黑盒变可诊断。
2. **调研门（先验证后决定）**：探测 `omp` / `codex` 是否有稳定的模型枚举（如 `omp --list-models` / `codex` 对应命令或配置）。
   - **若有** → 在 `doctor` 输出里**附带可用 model 列表**（复用现有 doctor，不新增工具，最省）；可选再加 `agent_bridge_list_models`。
   - **若无/不稳定** → 不强造枚举，停在第 1 级 + 文档列出 README 已知可用串，并明确「model 串合法性由后端裁定」。

**为何不一上来就 `list_models`**：避免对未验证的后端能力做出承诺、以及给一个会漂移的「可用列表」。第 1 级先把**最痛的「静默/含糊失败」**解决。

**成本**：第 1 级小；第 2 级取决于调研结果。

---

## 不改代码项

- **#4 token/成本**：按用户指定跳过。内部 `tokenUsage`/`contextUsage` 已有，将来加性接入。
- **#6 两步舞**：已有 `send_message(wait:true)`、`open_session(initial_prompt, wait:true)` 单步路径。仅在 SKILL/README 显式点出，消除「以为只能两步」的误解。

---

## 版本与兼容性

- 全部为**加性变更**（注入 env、`close_session` 省略 id、`wait` 新增 `pendingSnapshots`/`tail_chars`、错误信息增强），不删除/改名既有出参 → 既有调用零破坏。
- 建议 **0.7.0 → 0.8.0**（minor，新增能力）。SKILL/README 增「进度模式」「批量关闭」「进程标记」说明。

## 测试计划（实现后）

1. **#1**：起 omp+codex 会话，Linux 读 `/proc/<pid>/environ` 断言三个标记存在且值正确；Windows 至少断言子进程能起、标记注入不破坏启动。
2. **#5**：开 3 个会话，无 id `close_session` → 断言 `count===3`、`status`（无 id）返回空、后端进程全退。
3. **#2**：对一个长 turn 用 `timeout_ms=2s` 反复 `wait`，断言 `pendingSnapshots[].tail` 随时间推进变化、`charCount` 单增；最终 `result` 仍 head 截断。
4. **#3**：传非法 model `open_session`，断言错误信息含 `agent`+`model`+诊断提示；若实现枚举，断言 `doctor` 列出 model。
5. **回归**：omp+codex 全生命周期 open→send(非阻塞)→wait→status→result(max_chars)→复用→abort→close，校验既有出参形状不变（P1–P6 + v0.7.0 不变量）。

## 给评审方的开放问题

1. #2 用加性 `pendingSnapshots` 还是直接把 `pending` 升级为对象数组？（前者零破坏，后者更统一但破坏形状）
2. #1 是否本轮就把 cleanup 的 Linux env 校验一起做（PID 复用加固），还是留 TODO？
3. #3 `list_models` 值不值得做，取决于后端是否真有稳定枚举——有无已知的 `omp`/`codex` 列模型命令？
4. tail 默认 240 字是否合适？是否该让 `status`/`result` 也支持 `tail_chars` 以统一进度读取？

---

## 评审结论与修订（codex + deepseek-v4-pro 交叉评审，2026-06-09）

用 Agent Bridge 自身拉起 deepseek(omp) 与 codex 各做一遍独立只读评审。两方对评估表与设计**高度一致认可**，并补出几个真实缺陷与修订。要点如下，已据此调整计划。

### 评估表确认
- **#6（不改代码/文档）准确**：两方逐行确认 `send_message(wait:true)`、`open_session(initial_prompt,wait:true)` 已是单步路径。**新增 caveat（codex）**：inline `wait` 超时会 **abort 该 turn**（OMP L1006 / Codex L1529），所以 `send(wait:true)` **不等价于**「非阻塞 send + 反复 wait」——文档要写清这一点，否则用户会以为超时只是"没等到"而非"turn 被中断"。
- **#2 准确但偏乐观**：`status.recentEvents` 是**生命周期**可见性、刻意丢了 delta 文本（L362）；`lastAssistantText` 被 clamp 到末 400k（L316）。所以"看进度"必须靠 `result`/快照取部分文本，不能靠 `status` 看文本。

### 新增缺陷（计划原本漏掉，已纳入）
- **🔴 N1 · `open_session`+`initial_prompt` 超时 → 孤儿会话（deepseek，高优先）**：`openSession`（L1685）只 catch 了 `start()` 失败，**没 catch `send(initial_prompt)` 失败**。wait 超时时 `send` throw 冒泡成 MCP error，但 **session 仍留在 `sessions` Map**、且 error 不带 session id → 消费方无从 close → 真·孤儿。**修**：把首轮 `send` 包进 try/catch，失败时与 `start()` 失败一样 `sessions.delete(id)` + `session.close({removePidRecord:false})` 再 rethrow。与 #5/#1 同处一片代码区，顺手一起改。
- **🔴 N2 · cleanup 的 PID 复用误杀（codex，标为"最该优先"）**：`cleanupStalePidRecords`（L742）确认孤儿**仅靠命令行正则**（`omp --mode rpc` / `codex app-server`）。dead-owner 的 pid 记录若遇 PID 被复用且新进程恰好匹配该正则 → **误杀无关进程**。这正是 #1 env 注入**本可加固但本轮没做**的点。**结论**：#1 的"安全"叙述与"仅留 TODO"自相矛盾，二选一(见决策)。

### 设计修订
- **#1**：env 注入对 `roleMatchesCommand`/cleanup 安全**本轮影响为零**（两方一致）——只改外部归属。**删除/降级所有"PID 复用加固"措辞**，除非本轮就实现 Linux `/proc/<pid>/environ` 校验（见决策点）。env 注入本身启动风险极低但**非零**（命名冲突、向子工具泄漏元数据）——用 `AGENT_BRIDGE_` 前缀、值精简、注明仅诊断用。
- **#5**：① snapshot keys 先行**确实**足够避免迭代中改 Map（两方一致）。② **prune 合一**：不要每关一个就 `pruneLogs` 一次（N 次全量磁盘 scan），抽 helper 或加内部 `{prune:false}`，全删完再 prune 一次。③ **诚实返回**：`try/catch` 吞错后仍报 `closedAll:true` 是撒谎——改为返回 `{ closedAll: failed.length===0, count: 成功数, sessionIds, failed:[{sessionId,error}] }`。④ schema 描述**显式写明「省略 = 关闭全部」**，否则 LLM 不会自行推断。
- **#2**：① `pendingSnapshots` **加性、不动 `pending`**（两方一致，`mode:any` 循环已依赖 `pending` 是 id 数组，L1772）。② 进度缺失**不止超时分支**：`mode:any` 提前命中分支（L1772）同样只回裸 id，快照逻辑应**覆盖所有返回分支**。③ `tail_chars` **必须进 wait 的 `inputSchema`**（`additionalProperties:false` 是封闭形状，L140），且 `parseNumber` 只解析不校验边界——**clamp 负数/超大值**。
- **#3**：codex 实测探测——`codex --help`/`codex app-server --help` **无稳定列模型命令**；omp 本地 `--help`/`--list-models` 因读 Bun 源 EPERM 不可断。**结论：Level 2 枚举本轮不做**（后端无现成稳定枚举），只做 **Level 1**（非法 model 报错点名 `agent`+`model`+诊断）。

### 测试计划修订
- **删除**原 #2 测试里的「`charCount` 单增」断言——**错误**：`lastAssistantText` 会被 OMP 全量覆盖（L962）、clamp 到末窗（L316）、Codex settle 时替换为最终文本（L1434），并非全局单调。**改为**：断言快照存在且有界、`tail` 在已知流式 fixture 上随时间**变化**。

### 开放问题定稿
1. **加性 `pendingSnapshots`**（两方一致），不动 `pending`。
2. **见下方决策点**——两方均指出"安全收益 + 仅 TODO"不能并存。
3. **`list_models` 本轮不做**（后端无稳定枚举，codex 已实测），停在 Level 1。
4. **tail 默认 240 合理**；**不要**给 `result`/`status` 加 `tail_chars`(`result` 取开头是正确语义；进度统一走 wait 快照)。

### 待用户拍板的决策点
**#1 的"PID 复用安全"怎么处理（两方都点名）：**
- **(A) 仅注入 env 标记**：改外部可观测性（解决消费方原始诉求），cleanup 的误杀风险**仍在**——但叙述里**不再声称**安全加固。成本最低。
- **(B) env 标记 + 本轮就在 cleanup 消费它**：Linux/macOS 读 `/proc/<pid>/environ` 校验 `AGENT_BRIDGE_SESSION_ID` 匹配后才 kill，**真正关掉 N2 的误杀**（Windows 仍只能靠命令行，无法 env 校验 → 部分覆盖）。成本中等、Linux-only 收益。

> 修订后优先级：**N1（孤儿会话）+ #5 + #1 先做**（同代码区、低成本、N1 是真 bug）；**#2** 次之；**#3 Level 1** 随手；**N2** 取决于上面 (A)/(B) 决策。
