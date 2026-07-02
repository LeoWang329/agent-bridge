# Agent Bridge 重度用户优化建议

> **视角**：本文档由一名重度消费者（主 agent）在真实项目里连续使用 agent-bridge 后写成——用途是 **多引擎子代理驱动开发（SDD）**：持久 `omp`(DeepSeek-v4-pro, write, xhigh) 做实现 + 持久 `codex`(read-only, xhigh) 做实时评审 + 主 agent 规划与验收，贯穿一个 Next.js 项目 P1/P2 共约 15 个任务的 `dispatch → review → fix → re-review` 循环，中途还经历过一次上下文 compaction 并靠 `status` 恢复。
>
> **立场**：以下都是**用户视角**的诉求。凡出现"代码"，指的是我作为消费者**想要的接口形状 / 调用示例 / 应写进 SKILL.md 的用法**，不是对内部实现的规定——具体怎么实现由维护者定。
>
> **日期**：2026-07-01

---

## 目录

1. 两个最高杠杆的改进（问题 / 建议 / 接口与示例 / skill 用法）
2. 遇到的坑与不方便 + 对应修法
3. SKILL.md 的改进建议
4. 想更深度 / 重度使用，按优先级要补的（详解 + 具体做法）

---

## 1. 两个最高杠杆的改进

这两条不是"锦上添花"，而是决定 agent-bridge 能不能从"能用"走到"敢把多引擎流水线放量重度跑"的地基。

### 1.1 `send_message` / `wait` 支持 `schema`（结构化输出）—— 我最想要的一条

**问题（真实痛点）**
现在评审员（Codex）只能返回**自由散文**。我作为验收方，每一轮都要人肉把散文解析成"严重级别 / 文件 / 行号 / 失败场景 / 结论"，再逐条裁决（确认 / 假阳 / 打回）。在一个 ~15 任务的循环里，这个"读散文→归类→裁决→拼打回指令"是**最大的单项开销，也是最大的出错源**：
- 分类靠我理解，容易把 Important 误读成 Minor；
- "打回 DeepSeek"的指令得我手工从散文里摘要点重写，无法程序化；
- 散文全文还会滞留进我的上下文（见 1.2），长循环直接把我撑到 compaction。

你们的 **Workflow 工具已经有 `agent(prompt, {schema})`** 强制 StructuredOutput 的能力——**把同一能力搬到 `send_message` 上即可**，这是现成范式。

**改进建议**
给 `send_message`（及 `open_session` 的 `initial_prompt`）加一个可选入参 `schema`（JSON Schema）。传了之后：
- 桥在发给后端时追加"必须调用结构化输出工具、按此 schema 返回"的指令；
- 后端产出经 schema 校验，**不合规就让后端重试 N 次**（比如 3 次）；
- `wait` / `result` 的返回里多一个 **`json` 字段**（已校验的对象），主 agent 直接读 `json`，不再解析 `text`；
- 校验彻底失败时返回 `schemaError`（连同最后一次原始 `text`），让我能兜底。

**接口形状（想要的调用示例）**

```jsonc
// 评审请求：强制结构化 findings
agent_bridge_send_message({
  session_id: "codex-mr22jz3v-fybc3j",
  message: "对 <cwd>/tmp/p2-final-review-package.txt 的 diff 做终审，按 schema 返回。",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      verdict: { enum: ["READY_TO_MERGE", "NEEDS_FIXES"] },
      findings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            severity: { enum: ["Critical", "Important", "Minor"] },
            file:     { type: "string" },
            line:     { type: "integer" },
            summary:  { type: "string" },
            scenario: { type: "string" },   // 具体触发输入 → 错误结果
            confidence: { enum: ["CONFIRMED", "PLAUSIBLE"] }
          },
          required: ["severity", "file", "summary", "scenario"]
        }
      }
    },
    required: ["verdict", "findings"]
  }
})
```

```jsonc
// wait / result 返回里多出 json（已校验）；text 仍在，但我只读 json
{
  "sessionId": "codex-mr22jz3v-fybc3j",
  "status": "idle",
  "json": {
    "verdict": "NEEDS_FIXES",
    "findings": [
      { "severity": "Important", "file": "src/middleware.ts", "line": 14,
        "summary": "无 cookie 的 /api/* 被 302 跳登录页而非 401 JSON",
        "scenario": "curl 无 cookie POST /api/submissions → 收到 302 HTML", "confidence": "CONFIRMED" }
    ]
  },
  "charCount": 812, "textRef": "…/codex-….answer.txt"
}
```

**为什么这条杠杆最高**：它把"评审 → 裁决 → 打回"从**人肉散文流程**变成**程序化流水线**——我可以直接 `json.findings.filter(f => f.severity !== 'Minor')` 决定打回哪些、用 `json` 里的 `file/line/scenario` 自动拼 DeepSeek 的修复指令、把 Minor 归档进台账。多引擎 SDD 的整个价值就锁在这一步的可编程性上。

**该写进 SKILL.md 的用法（新增小节，风格贴合现有文档）**

> ### 结构化产出（评审 / 抽取 / 分类）
> 需要**机器可读**的产出——评审 findings、从文本抽字段、把结果归类——就给 `send_message` 传 `schema`（JSON Schema）。返回里读 **`json`**（桥已按 schema 校验），**不要再自己解析 `text`**。典型：`评审 → 裁决 → 打回` 流水线里，用 `json.findings` 直接筛严重级别、按 `file/line/scenario` 程序化拼"打回"指令。校验失败会回 `schemaError` + 原始 `text`，据此兜底。不需要机器可读（就是让对方改代码/写文档）时不用传，保持 `text`。

---

### 1.2 文件优先 I/O（双向）+ 默认摘要回传 —— 控住上下文成本

**问题（真实痛点）**
`result` / `wait` **默认把完整结果内联返回**（除非我每次都记得手动传 `max_chars`）。而我的评审**请求**本身也很大（全局约束 + R1–R4 残留项 + focus 区），这段 `message` 文本同样滞留进我的上下文。一个多引擎循环里，评审请求、评审结果、修复报告**双向**都在堆我的上下文——我这次项目中途就被 compact 了。`textRef`（answer.txt）已经存在，但它是"兜底"不是"默认"，且只解决了**输出**一侧、还得我主动取。

**改进建议**（三件，可分批做）
1. **输入侧 `message_file`**：允许消息体从一个文件路径读（共享 cwd），这样大 prompt 不进主 agent 上下文。
2. **输出侧 `output_to`**：让我指定结果落盘路径，`wait`/`result` **只回 `{ outputPath, charCount, summary }`**，不回全文。
3. **会话级默认 `return_mode`**：`open_session({ …, return_mode: "ref" | "summary" | "full" })`。评审 / 长循环会话设成 `ref`，此后每一轮默认只回 path + 摘要 + `textRef`，要全文再显式取。默认值保持 `full` 以不破坏现有行为。

**接口形状（想要的调用示例）**

```jsonc
// 开一个"低上下文成本"的评审会话：默认只回摘要 + ref
agent_bridge_open_session({ agent: "codex", cwd: "D:\\cc\\proj", write: false, return_mode: "ref" })

// 大请求走文件、结果落文件、再叠加 1.1 的 schema
agent_bridge_send_message({
  session_id: "codex-…",
  message_file: "D:\\cc\\proj\\tmp\\review-req-task9.md",   // 大 prompt 不进我上下文
  output_to:    "D:\\cc\\proj\\tmp\\review-out-task9.json", // 结果落盘
  schema: { /* 见 1.1 */ }
})

// wait 返回：无全文，只有指针 + 摘要
{ "sessionId": "codex-…", "status": "idle",
  "outputPath": "…/review-out-task9.json", "charCount": 812,
  "summary": "NEEDS_FIXES：2 Important（middleware 401 契约 / tmp 泄漏）" }
```

**为什么重要**：多智能体编排的官方哲学就是"产物走文件、不走粘贴文本"。但桥当前默认**返回内联全文**，恰好和这个哲学对着干。把文件 I/O 变成**一等公民**、并允许**会话级默认摘要**，长任务才跑得动、才不会被自己的中间产物撑爆。

**该写进 SKILL.md 的用法（补进「上下文卫生」小节）**

> **长循环 / 大产出的上下文卫生（进阶）**：评审、多任务串跑这类会攒很多中间文本的场景，① 开会话时传 `return_mode:"ref"`，之后默认只回 `outputPath` + `summary` + `textRef`；② 大 prompt 用 `message_file` 从文件喂入；③ 结果用 `output_to` 落盘。把**输入和输出两侧的大文本都挡在主 agent 上下文之外**，只在上下文里留"指针 + 一行摘要"。要看细节时再读那个文件。这是在 `max_chars` 之上、面向重度循环的默认卫生手段。

---

## 2. 遇到的坑与不方便 + 对应修法

> 按"实际咬到我 / 会咬到重度用户"的顺序。有些 SKILL.md 已部分覆盖，这里只列**仍是缺口**的部分。

| # | 坑 / 不方便 | 现象（我真实遇到 / 会遇到） | 建议修法 |
|---|---|---|---|
| 2.1 | **只读会话不能写文件 → 评审报告被迫回上下文** | Codex 只读，没法把 findings 落成文件，只能经 turn result 回到我上下文（正是 1.2 的根因之一） | 给只读会话一个**受限 output 白名单**（只允许写 `output_to` 指定的那个文件 / tmp 子目录）；或直接靠 1.2 的 `output_to` + 桥代写落盘绕开 |
| 2.2 | **`write` 是开会话时定死的** | 评审中途想让 Codex"顺手改一行"，要么它只读做不了、要么得另开 write 会话丢掉评审上下文 | 加**每消息 write 开关** `send_message({…, write:true})`；或只读会话支持"**产出 unified diff/patch（不落盘）**"模式，由我 apply。既保只读安全，又能一步拿到修法 |
| 2.3 | **`lastError` 语义不清：吓人但无害** | `status` 里 Codex 报 `lastError: "failed to refresh available models: timeout waiting for child process to exit"`，会话其实照常工作，我分不清致命 / 瞬时 | 用**明确健康态**替代裸 error 串：`health: "healthy" | "degraded" | "dead"`，把瞬时后端错误归到 `degraded` 并**自动重试**，`dead` 才需要我干预。裸 error 放到 `lastError` 供排查即可 |
| 2.4 | **零 token / 成本可见性** | 一轮多引擎跑下来，我完全不知道 DeepSeek / Codex 各烧了多少 token / 钱 | `status` / `wait` 返回里加 **per-turn 与 per-session 的 token 计量**（`inputTokens/outputTokens/turns`），有条件再加**预算上限**（见 4.2）。重度放量的前提 |
| 2.5 | **会话只有不透明 id，无别名** | 全程手工搬 `omp-mr22ho12-hzdxx5` / `codex-mr22jz3v-fybc3j`，compaction 后靠 `status` 找回，易搬错 | `open_session({…, name:"dev" | "reviewer"})`，之后可用 name 寻址；`status` 里回显 name。降低跨长会话的搬运错误 |
| 2.6 | **在途只有文本尾巴，没有结构化进度** | xhigh 的 DeepSeek 一轮好几分钟，我只有 `pendingSnapshots.tail` 的文本末尾，不知道它在改哪个文件、跑没跑测试 | `pendingSnapshots` 里补**结构化事件**：`lastToolCall`（如 `Edit src/x.ts` / `Bash npm test`）、`filesTouched`。让长 turn 不再是黑盒（比纯 `tail` 更可判断"在动 vs 卡住"）|
| 2.7 | **手工攒 review package 是重复劳动** | 每轮我都 `git log + diff -U10` 拼一个大文件再把路径丢给只读 Codex（共享 cwd 读——这套很好用），但拼包全靠我手写 | 提供一个可选的**评审输入助手**（脚本或 tool）：给定 `BASE HEAD` 生成"commit 列表 + stat + full diff"到一个文件并回路径。把我反复手写的 `git` 拼包固化成配方 |

> 说明：2.7 里"共享 cwd + 用绝对路径把大 diff 交给只读会话自己读"这个**机制本身非常好用**（既不进我上下文，只读也能消费大产物），只是"拼包"这步还得我手工。

---

## 3. SKILL.md 的改进建议

> SKILL.md 已经写得相当扎实（非阻塞 send + 短超时 wait、`wait` 三种返回 shape 表、并发纪律、上下文卫生、模型全限定 ID、effort 量体裁衣都覆盖到了）。以下只提**增量**——补上我踩过、但文档还没给"配方"的地方。

- **3.1 补「评审员配方」小节**。我这套是自己拼出来的，写进 skill 能让后续 agent 少走弯路：
  > **评审员标准配方**：① 评审者 ≠ 实施者（换引擎 + 新开只读会话，见「评审独立性」）；② diff **走文件**——`git diff -U10 BASE HEAD > tmp/pkg.txt`，只把**路径**丢进 `message`，让只读会话在共享 cwd 里自己读（省 token、只读也能消费）；③ 产出**走 `schema`**（见结构化产出小节），返回读 `json.findings`；④ **复用同一评审会话**跨多个任务——评审员会"学会"你之前的裁决口径（实测：驳回一次假阳后，同类假阳显著减少）。
- **3.2 把 `max_chars` / `textRef` / `return_mode` 明确定位成「长循环默认卫生手段」**，而不是只在参数说明里一笔带过。加一句经验值：评审 / 大产出会话建议开 `return_mode:"ref"`，或每次 `send` 传 `max_chars:4000` 只看头部。
- **3.3 给 `tail_chars` vs `max_chars` 一行对照示例**（现在文字讲了，但很微妙）：
  > `tail_chars` = 在途文本的**尾部**（对方此刻正在吐什么，超时也 actionable）；`max_chars` = 成品文本的**头部**截断（成品太长只看开头）。一个看"在做什么"，一个看"做出了什么"。
- **3.4 补「compaction / 断线恢复」配方**（我真用到了，但文档没写）：
  > **主 agent 上下文被压缩后**：`agent_bridge_status`（不传 `session_id`）列出你开的全部会话，从中认回 `session_id`（配合 3.5 的 `name` 更稳），继续 `send`/`wait`。会话活在 MCP server 进程里，只要客户端没退就还在。
- **3.5 `doctor` 的定位再收紧一句**：现在文档说了 `doctor` 只是 `--version` 预检、不验登录。建议再补：**搭多引擎工作流前，用 `doctor` 确认三条腿（omp/codex/claude）都在**，别等 `send` 了才发现某后端没起来。（如未来实现 4.5 的逐后端探活，这里同步升级。）
- **3.6 结构化产出与文件 I/O 落地后**，在「工具速查」表和「Prompt 写法」里同步加 `schema` / `message_file` / `output_to` / `return_mode` 的一行说明——**否则后续 agent 根本不知道有这些参数、也就不会用**（这正是用户特意强调"要写进 skill"的原因）。

---

## 4. 想更深度 / 重度使用，按优先级要补的

> 排序原则：先补**决定"敢不敢放量"的地基**（可编程产出、成本可见、上下文可控），再补**编排力度**（并行、可观测、灵活读写）。每条给"为什么 + 具体做法"。

### 4.1 结构化输出 `schema`（最高优先）
- **为什么**：见 1.1。这是把多引擎流水线从"人肉散文"变"可编程"的地基，其它一切编排的价值都建在"产出可被程序消费"之上。
- **具体做法**：复用 Workflow 已有的 StructuredOutput 机制；`send_message` 加 `schema`，返回加 `json`，校验失败重试 N 次后回 `schemaError`。先支持 Codex（评审主力），再覆盖 omp/claude。

### 4.2 Token / 成本计量 + 预算（重度放量前提）
- **为什么**：见 2.4。不知道花了多少，就不敢把并行度和 effort 往上放。重度用户需要"这轮/这个会话烧了多少"来做取舍。
- **具体做法**：
  1. `status` / `wait` / `result` 返回加 `usage: { inputTokens, outputTokens, turns }`（per-session 累计 + 本轮 `lastTurn.usage`）。
  2. 进阶：`open_session({…, budget: { outputTokens: 500000 } })`，超预算的 `send` 直接被拒（回 `budgetExceeded`），像 Workflow 的 `budget` 那样。
  3. 若后端能回真实计费就透传；不能就按 token 估算并标注"estimated"。

### 4.3 文件优先 I/O（双向）+ 默认摘要（上下文可控）
- **为什么**：见 1.2 / 2.1。长循环里不控住双向文本，主 agent 会被自己的中间产物撑爆（我已中招一次 compaction）。
- **具体做法**：`message_file`（输入）、`output_to`（输出）、`open_session.return_mode:"ref"|"summary"|"full"`（默认 `full` 保后向兼容）。只读会话的落盘由桥代写到 `output_to`，绕开 2.1 的只读限制。

### 4.4 并行 fan-out 原语（编排力度）
- **为什么**：`wait` 已支持多 id + `mode:"any"/"all"`（很好用），但"开 N 个 + 逐个 send"是 N×2 次调用，样板多。重度场景（**同一 diff N 个不同视角评审员并行、多数表决**这种对抗式验证）需要更省样板。
- **具体做法**：
  1. `open_sessions([{agent,model,name}, …])` 批量开，返回 id 数组；
  2. `broadcast(session_ids, message | message_file, schema?)` 一条消息群发；
  3. 配合 `wait(mode:"all")` 归并。让"N 个评审员并行 + 收齐比对分歧"变成 3 次调用而不是 2N+1 次。

### 4.5 健康态 + 瞬时错误自动重试 + 会话别名（可控运维）
- **为什么**：见 2.3 / 2.5。黑盒运维在重度跑时会放大——一个吓人的 `lastError`、一个搬错的 id，都会打断长循环。
- **具体做法**：
  1. `health: healthy|degraded|dead` 三态；`degraded`（瞬时后端错误，如"refresh models timeout"）**自动重试**，`dead` 才升级给我。
  2. `doctor` 从"只查 `--version`"升级为**可选的逐后端真探活**（能否真启动一个空会话），让搭流水线前的确认更可靠。
  3. `open_session({…, name})` + `status`/返回回显 `name`，可用 name 寻址。

### 4.6 在途结构化进度 / 工具事件流（可观测）
- **为什么**：见 2.6。长 turn 的黑盒感在 xhigh + 大任务时最强；只有文本尾巴不够判断"卡住还是在推进"。
- **具体做法**：`pendingSnapshots` 加 `lastToolCall`（`{tool, argSummary}`，如 `Edit src/x.ts`、`Bash npm test`）与 `filesTouched`；`recentEvents` 已过滤噪声，这里只需把**工具级事件**结构化暴露出来。

### 4.7 每消息 write 开关 / 只读产 patch 模式（灵活读写）
- **为什么**：见 2.2。"角色在开会话时定死读写"太僵——评审中途发现一个一行修法，却要么做不了、要么另开会话丢上下文。
- **具体做法**：`send_message({…, write:true})` 逐条提权（默认仍随会话）；或只读会话支持"**产出 unified diff（只回不落盘）**"，由主 agent 决定是否 apply。既守只读安全边界，又让"评审顺带给修法"一步到位。

---

## 附：用下来真正好用、请别动的部分

给维护者一个平衡视角——这些是 agent-bridge 已经做对、构成核心价值的地方，改动时请小心别破坏：

- **持久会话保上下文**：全程复用同两个会话，让评审员"学会"了我的裁决口径（驳回假阳后同类假阳显著减少）。这是无状态子代理给不了的。
- **共享 cwd + 绝对路径交接文件**：只读会话也能消费大 diff，还不进我上下文。设计很干净（建议在文档里升级为"评审推荐模式"，见 3.1）。
- **`status` 列全部会话**：compaction 后的救命稻草。
- **ack-then-join（非阻塞 send + 短超时 `wait` + `tail_chars`）**：异步语义设计到位，超时不中断 turn、还能看在途尾巴，很贴心。
- **`textRef` 永远是全文、`charCount` 永远回全长**："必读内容绝不静默丢失"这条契约让我敢放心用 `max_chars` 截断。

---

*—— 一名把 agent-bridge 当多引擎 SDD 主力的重度用户*
