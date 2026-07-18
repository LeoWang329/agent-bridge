---
name: agent-bridge-dev
description: 用 agent-bridge 跑委托式代码开发/评审/设计/调试的编排指南。为委托 agent 注入预置角色人格(implementer / reviewer / architect / debugger),并组织实现→独立评审→修→复评的闭环。仅当用户明确要求用 agent-bridge 委托做开发类工作(实现/评审/方案/调试)时使用;普通编码、小修小补、自己就能做的不要触发。依赖 agent-bridge skill 与其 MCP 工具。
---

# Agent Bridge · Dev(角色委托编排)

把 agent-bridge 的委托能力用出**工作流**:该派谁、注入什么角色、怎么保证评审独立、闭环怎么转。角色人格是预置的
可注入 md(见 `roles/`),启动委托 agent 时用 `append_system_prompt_file` 注入。

> **本 skill 只讲"编排角色"。桥本身的机制/纪律是另一份真理源。**

## 前置(务必先看)

1. **工具存在性守卫**:若当前工具列表里**没有** `agent_bridge_*` 工具,**停止**,提示用户先安装/启用 agent-bridge
   MCP 服务器再来(工具只在 MCP server 已装/启用时才在)。
2. **先加载桥 skill 拿完整用法**:本流程建立在 agent-bridge 之上。**先加载 `agent-bridge` skill**(手动 link 态其名为 `agent-bridge`,让 harness 解析),它有完整的工具用法、返回 shape、
   并发纪律、`textRef` 关会话前读取等。本文件只在关键处**重复两条最致命的纪律**(下方),其余以桥 skill 为准。
3. **两条致命纪律(内联,别只靠跨引用)**:
   - `agent_bridge_wait` **必须传 `timeout_ms`**(如 `300000`≈5 分钟短轮询循环),**不传默认死等 30 分钟**。
   - **别给 `send_message`/`open_session` 传 `wait:true`**——超时会 **abort 掉那一轮 turn**(任务被中断,不是回头再取)。
     用非阻塞 send + 短超时 `wait` 收口。

## 角色速查

| 角色 | 干什么 | 默认 `access` | 典型 `effort` | 角色文件 |
|---|---|---|---|---|
| implementer | 按 spec 实现、TDD、自查、提交、汇报 | `"write"` | `high`~`xhigh` | `roles/implementer.md` |
| reviewer | 只读评审:规格符合度 + 代码质量,给 APPROVE/NEEDS_FIXES/BLOCKED | `"read"` | `medium`~`high` | `roles/reviewer.md` |
| architect | 出 2–3 方案 + 权衡,只设计不实现 | `"read"` | `xhigh` | `roles/architect.md` |
| debugger | 系统化根因定位再修;可写诊断埋点/失败测试(不改功能修复直到根因确认,靠行为纪律) | `"write"`(并行调查改 `"read"`) | `high`~`xhigh` | `roles/debugger.md` |

- **选哪个角色**:方案/架构未定 → architect;已定任务的实现 → implementer;评审改动 → reviewer(异于 implementer);
  bug/失败/异常 → debugger(用下方"调试:多 agent 并行根因")。
- **建议能力档**(默认偏好,遵下方 §model 弹性策略):architect → 见「架构设计:多轮讨论」段(按段内默认偏好,
  需用户确认);最终整支评审 → 最强档;debugger 根因 → 最强档,且并行两个**引擎互不相同**;reviewer → 中~最强
  (随 diff 复杂度,且异于 implementer 的引擎/模型);implementer → 低延迟~中档(机械转录用低延迟档,复杂集成用中档)。
- **铁规:每次为角色开会话都必须注入对应角色文件**(`append_system_prompt_file=<base>/roles/<角色>.md`)——
  不注入 = 委托 agent 没有身份 = 白派。

## 整体工作流(主模型编排)

你(主模型)是**编排者/调度者**,先规划再逐任务闭环,不把活一股脑丢出去:

1. **规划 & 分解**:把需求拆成带明确验收标准的任务;**方案不清就用「架构设计:多轮讨论」**(见下段;需用户确认后拉
   claude+codex 与你多轮打磨)再定。
2. **逐任务闭环**(走完一个再下一个):**实现**(implementer)→ **审核**(reviewer;起疑时跑聚焦测试)→ **修复** →
   **复审** → **验收**。
3. **验收通过 → 下一任务**;不通过就回修复/复审,别带着未合格的任务往下走。任务相互独立时并行(见"并行委托")。

**测试落在哪(别把"审核测试"误读成 reviewer 跑测试)**:implementer 按 TDD 写并跑测试(汇报即证据);主模型收口后
自己 `git diff` + 跑必要测试(评审循环 §5);**reviewer 不重跑全套**,只在读代码起疑时跑聚焦测试。

## 委托机制(核心循环)

```
open_session(agent, cwd(绝对), access, model, effort,
             append_system_prompt_file=<绝对路径>/roles/<角色>.md)   → session_id
send_message(session_id, message)         默认非阻塞,立刻拿 ack
wait(session_ids, mode:"any", timeout_ms:300000)   收结果(务必传 timeout_ms;别用 wait:true)
读 text / textRef(关会话前读全文)
close_session(session_id)                 用完必关
```

给委托 agent 的 `message` 只放**任务本身**:要做什么、边界、完成标准、要读哪些文件/评哪个范围。**别把整坨 diff/代码
塞进 message**——你们共享 `cwd`,让对方自己 `git diff` / 读文件(省 token)。角色人格由注入文件负责,不必在 message
里重复"你是评审者"。

## 角色文件的绝对路径(照这个取,别留隐含知识)

`append_system_prompt_file` **要求绝对路径**,且桥不做 base 拼接/相对回退——你必须传一个已解析好、存在的绝对路径。

- 角色文件在**本 skill 加载时 harness 给出的 base directory** 下的 `roles/` 里。以该 base 拼
  `<base>/roles/<角色>.md`。此法在本地/手动 link 态都成立(`roles/` 随 skill 目录一起 link)。
- **传前验证**:确认拼出来的是绝对路径且文件存在、非空;拼错(相对路径/base 为空)会让 open_session 直接失败。
  Windows 下 base 是 `D:\...` 原生形态,直接可用。
- **allow-list**:只允许四个固定角色名 → `roles/<名>.md`。**绝不**把用户传入的任意路径当角色文件注入。

## model / effort 选择(弹性:默认 → 缺了自行挑 → 拿不准问用户)

**不点名具体后端/模型**——它们会变,写死会失效。按能力挑,具体名靠活查:

- **默认偏好**:给每个角色一个默认(按能力档 + 评审者≠实施者),不绑产品名。
- **缺了自行挑**:派活前 `agent_bridge_doctor` 看哪些后端在(当前 omp/codex/claude/cursor/kimi;新增 CLI 同理按 doctor 走)。
  默认不可用时,按**同样的能力标准自行挑一个合适替代**——但**必须遵守评审独立性**(见下):与实施者相同的
  引擎/模型候选直接排除,不能因"能力档最高可用"就悄悄挑到同一个。
- **拿不准就问用户**:排除实施者后能力档无合适候选、或你无法判断怎么挑,**停下与用户确认**,不硬凑。
- **能力分层**:机械实现用低延迟/足够能力档;集成/判断用中档;架构/最终整支评审用最强档(**不是"最便宜"**,别与
  "质量优先、不为省 token 缩水"冲突)。
- **模型清单靠活查**:OMP 用 `omp models <关键字>`(子命令,非 flag;你的 shell 跑,非 MCP 工具),`model` 传全限定
  `provider/名`;Codex/Claude 用后端默认或用户给定的有效模型(它们没有 `models` 子命令);cursor 用 `agent --list-models`,selector 带档位后缀(如 `gpt-5.3-codex-high`);kimi 用 `kimi provider list`,`model` 传 `kimi-code/…` 别名。具体模型 ID 不写死。
- **cursor / kimi 特例(见桥 skill 的对应条目)**:两者都可担任一角色,但角色注入是**首轮软注入**——架构讨论是**多轮长会话**,它们的角色纪律长程未验证、经压缩可能漂,**要长程稳守角色的关键位优先真 system 提示后端(omp/codex/claude)**;另两者 `contextUsage` 都恒 `null`(按 token 判轮换失效,把 `null` 当未知、别当 0)、都仅 Windows;cursor 另有云端 chat 删不掉,kimi 无云端 chat 存储但**推理仍走 Moonshot 云端**(prompt 出本机)。

## 评审独立性(硬规则)

**reviewer 的引擎/模型必须 ≠ implementer 的**——引擎或模型不同才算真第二意见。别用同引擎同模型评自己刚写的代码;
换一个不同引擎/`model` + **新开独立会话**。

## 评审循环

1. **实现**:open implementer(`access:"write"`,能力/effort 按任务)→ send 任务 → `wait(mode:"any", timeout_ms:300000)`
   → 读产出。
2. **独立评审**:open reviewer(`access:"read"`,**异于 implementer 的引擎/模型**)→ 给**冻结的评审范围**(明确 `base..head` + 路径,并要求
   "评审期间该范围不得变更";未提交改动先让实现者 commit/stash 定住,或你保证工作区静止)。read 档**自带 shell**,reviewer
   能自己 `git diff` 拉取范围(各后端 read 档都有 shell)→ `wait(mode:"any", timeout_ms:300000)` → 读 verdict。
3. **修 → 复评**:按 Critical/Important 让实现者修(同会话追问)→ 重新 open/送 reviewer 复评,直到 `APPROVE`。
4. **整支 broad review**:全部任务完成后,做一次覆盖整分支的评审(最强档模型)。
5. **主 agent 自查**:委托方收口后,**你(主 agent)仍须自己 `git diff` + 跑必要测试再向用户报告,不盲信委托 agent**
   (与 `agent-bridge` skill 安全规则一致)。

## 架构设计:多轮讨论(需用户确认后开启)

架构/方案设计默认是一场**多轮讨论**,不是单发。主模型(你)牵头,**按用户设定的默认偏好,优先拉 claude code
(`model:"opus"`,`effort:"xhigh"`)+ codex** 两个 agent(引擎互不相同),各注入 `roles/architect.md`,与你一同多轮
打磨方案。**这是默认偏好,派活前仍遵 §model 弹性策略**(不可用 → 自行挑相当替代 → 拿不准问用户)。

**何时用(否则跳过,YAGNI):**
- 有 ≥2 个合理路径且**选错代价高**;或触及数据模型 / 公共 API / 并发模型 / 框架选型 / 跨模块契约等**不可逆、高风险**决策。
- 需求模糊或过大,需先拆成子项、理清边界与验收标准。
- 想要**独立设计二审**(拿别人的设计和你的比,分歧 = 盲点)。
- implementer 因"有多个合理方案的架构决策"`BLOCKED` 升级。
- **跳过**:路径唯一 / spec 清楚 / 局部改动 / 改错易回退,或你几句话就能定 → 直接 implementer,别走过场。

**流程:**
0. **先与用户确认再开启**(要拉 2 个 agent + 多轮,成本高):说清要讨论什么、拉谁、大致轮数(通常 **2–3 轮**),
   用户点头再开。
1. **默认阵容**——claude(`opus`,`xhigh`)+ codex,均 `access:"read"`(只设计不写,并行无写碰撞)。不可用则按能力档
   自行挑相当替代,但**仍保持两个 architect 引擎互不相同**;只剩一个可用时,问用户是否降级为"单 agent + 主模型"设计。
2. **多轮讨论(有界)**:主模型给两方**同一份**问题(目标/约束/已知)→ 各出方案 → 循环 `wait(mode:"all", timeout_ms:300000)`
   到齐 → 主模型综合、点出分歧 → 把分歧与交叉观点回抛给两方再议。复用各自会话**逐次**追问——**同一会话不并发 send**。
   **停止条件(满足任一即进 step3)**:分歧已缩小到"可决策的取舍"、两方开始重复论点、或**达 3 轮上限**;某一方持续
   `timedOut`(wait 返回 pendingSnapshots)则**跳过该方**,主模型自行拍板并标注缺口。
3. **产出 + 用户确认**:主模型综合出最终设计(采纳方案 + 权衡 + 未决点)→ **交用户过目确认** → 用户点头后才进入实现
   (交 implementer)。需用户拍板的取舍,停下问。

## 调试:主模型 + 2 个异引擎 agent 并行根因

bug / 失败 / 异常**不要只开一个 debugger**——根因判断最需要独立视角。主模型协调,两个**引擎互不相同**的 agent
(如 codex + deepseek)各自独立定位,再由主模型比对收敛:

1. **主模型固化现场**:复现步骤、错误/栈、最近改动、已知证据 → 写成给两个 agent 的**同一份**任务。
2. **并行独立调查**:`open` **2 个 debugger 会话,`access:"read"`,两个引擎互不相同**(如 codex + deepseek),各注入
   `roles/debugger.md`。逐个非阻塞 `send_message` → **循环** `wait(mode:"all", timeout_ms:300000)`(超时返回
   `timedOut/settled/pending` 而非最终 `results`——看 `pendingSnapshots` 后继续 `wait` 到两边都完成)。并行一律
   **只读**:两个写会话会撞同一批文件,所以调查阶段用 `access:"read"`(覆盖 debugger 默认的 `"write"`)。
3. **主模型比对根因**:两边**一致** = 高置信;**分歧** = 往往正是真问题所在,针对分歧点再查。
   - **需诊断埋点时**(某 debugger 在调查中建议"在 X 处加日志"):这是**反馈循环**,不是调查前的一次性动作——由
     **主模型统一加一次**埋点(避免两方各自写),再把输出喂回**提建议的那个 debugger** 单独追问继续(非并行)。
4. **单一 writer 修复**:根因定死后,**只用一个** write 会话(debugger 或 implementer,`access:"write"`)写失败测试 + 改根因
   (避免并行写碰撞)。
5. **复审 + 自查**:修复走评审循环(reviewer 异于 implementer)+ 主模型 `git diff` + 跑测试。

> 按 bug 规模伸缩:一眼可见根因的小 bug 不必兴师动众;这套用于真正需要独立视角的问题(YAGNI)。

## 并行委托

任务能切成**相互独立**的子任务时,多开会话并行——显著压缩总时长:
- 逐个非阻塞 `send_message`(都立刻拿 ack)→ `wait(mode:"any", timeout_ms:300000)` 循环收口(先完成先处理;把返回的
  `pending` 纯 id 数组当下一轮 `session_ids`)。
- **`write` 会话别撞同一批文件**(含主 agent 自己);无法保证不重叠就串行(前一个完成 → `git diff` → 作为上下文
  写进下一个的 prompt)。
- **同一会话别并发 `send`**(Codex 报 running turn,OMP 排队搅乱上下文)。要并行就开多个会话。

## 上下文卫生

同一任务线的追问复用同一 `session_id`;出现"新任务且无关"或"委托方开始遗漏关键约束"就 `close` 旧的、`open` 新的。
reopen 时按交接物带上下文(文件路径、规格、上一步 diff 写进新 prompt),不靠旧会话记忆。一条任务线结束就及时关。

## Integration / 跨引用

- **依赖 `agent-bridge` skill**:完整工具用法、返回 shape、并发纪律、doctor/models 探测都在那。跨引用用
  `agent-bridge` 让 harness 解析,**确保手动 link 态部署指得到桥 skill**。
- **依赖 `append_system_prompt_file`**(本仓 open_session 参数,注入角色 md 为整会话追加 system 指令)。

## 示例工作流(实现一个小功能)

```
1. doctor 看后端可用性;按 §model 选 implementer 的引擎/模型(默认→缺了自行挑→拿不准问)。
2. open implementer(access:"write", append_system_prompt_file=<base>/roles/implementer.md)
   send "实现 X(读 docs/spec-X.md 为准),完成标准:… 边界:不动 Y。"
   wait(mode:"any", timeout_ms:300000) → 读 Status/commits/测试小结。
3. 定住范围:实现者已 commit → 直接用 base..head;未 commit → 先让它 commit/stash 定住,或你保证工作区静止。记下 base..head。
4. open reviewer(access:"read", **异于 implementer 的引擎/模型**, append_system_prompt_file=<base>/roles/reviewer.md)
   send "评审范围 <base>..<head>,路径 src/x/**;评审期间该范围不变。"(read 档自带 shell,reviewer 自己 `git diff` 即可)
   wait(mode:"any", timeout_ms:300000) → 读 规格符合度 + 问题 + verdict。
5. verdict=NEEDS_FIXES → 回 implementer 会话追问修 → 重新送 reviewer 复评(同样 `wait(mode:"any", timeout_ms:300000)`),直到 APPROVE。
6. 主 agent 自己 git diff + 跑测试 → 向用户报告。
7. close 两个会话。
```
