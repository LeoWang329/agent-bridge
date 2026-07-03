# 设计:`agent-bridge:dev` 角色委托 skill

> 状态:设计已批准(2026-07-03)。**已过 codex + deepseek 双评并整合修正(R1)**,待写实现计划。
> 目标读者:实现者(下一步用 writing-plans 拆任务)。

## 1. 动机与目标

agent-bridge 现在能把任务委托给本地 OMP / Codex / Claude,并且(本轮新增)能在 `open_session` 时用
`append_system_prompt_file` 注入一个 md 文件作为整会话的追加系统指令。

缺的是**如何用好它做代码开发**的这层工作流知识:什么时候派实现者、什么时候派独立评审、评审循环怎么转、
并行怎么切、每个角色该是什么身份和纪律。superpowers 插件已经把这套沉淀成了单一职责的 skill + 角色 prompt 文件,
但它的机制是"用 Task 工具派 subagent + 在 prompt 里选 model"。

**本 skill 把 superpowers 的角色定义与工作流迁移过来,把"派 subagent / 选模型"的机制换成 agent-bridge 的
`open_session` + `append_system_prompt_file` + 会话级 `model`/`effort`。** 产出:一套可注入的角色人格 md + 一份
编排指南。

**非目标:** 不迁移 superpowers 的脚本/账本基础设施(`scripts/review-package`、`scripts/task-brief`、
`.superpowers/sdd/progress.md` ledger)——agent-bridge 共享 cwd,委托方直接 `git diff`/读文件即可;进度用主 agent
自己的 todos 跟踪。不改 `scripts/agent-bridge.mjs`(纯 skill/文档工作)。

## 2. 打包与命名空间

新增一个 skill 目录到 **现有 agent-bridge 插件**(skill 由 `skills/` 目录自动发现,plugin.json 无需登记):

```
skills/
  agent-bridge/          (已有:桥的机制/工具用法/并发纪律)   → agent-bridge:agent-bridge
  dev/                   (新增)                              → agent-bridge:dev
    SKILL.md             ← 编排大脑:何时用哪个角色、怎么注入、评审独立性、评审循环、并行
    roles/
      implementer.md     ← 可注入人格(固定 allow-list,见 §4/§9)
      reviewer.md
      architect.md
      debugger.md
```

- **A + 跨引用**:`dev/SKILL.md` 不重复桥机制,而是在开头声明前置、在 Integration 段引用 `agent-bridge` skill。
  桥机制保持**单一真理源**,dev 专注"角色编排"这一个职责。

### 2.1 安装/发现矩阵(R1 Critical:命名空间只在插件形态成立)

`/agent-bridge:dev` 这个命名空间**不是所有安装形态都成立**,实现必须按形态交代清楚,并更新 README:

| 安装形态 | 发现依据 | `skills/dev` 会被发现? | 调用名 |
|---|---|---|---|
| Claude Code 插件(README 方法 B:marketplace/`/plugin install`) | Claude Code **按约定**自动发现 `skills/*/SKILL.md`(不需在 `.claude-plugin/plugin.json` 显式登记;现有 agent-bridge skill 即这样加载) | ✅ | `agent-bridge:dev` |
| 本地开发(`claude --plugin-dir "$PWD"`) | 同上(Claude Code 机制) | ✅ | `agent-bridge:dev` |
| Codex / 非插件(README 方法 C:手动 link,本仓 Codex 的**受支持路径**) | README 手动 link **只 link `skills/agent-bridge` 一个子目录** | ❌ sibling `skills/dev` 不会被 link | 需改 README:另 link `skills/dev` → `~/.codex/skills/dev`,调用名 **`dev`**(用户 skills 目录无插件命名空间) |

> 注(R2 Critical:别混发现依据):`.codex-plugin/plugin.json` 声明了 `"skills":"./skills/"`,那是 **Codex 插件式**
> 打包的发现依据——但 README 明确本仓 Codex **不走** `codex plugin add`,受支持路径是方法 C 手动 link;Claude Code
> 插件态的发现是 Claude 自己的约定,**与 `.codex-plugin` 无关**。

**实现动作**:更新 README 方法 C / 快速上手,增加 link `skills/dev` 的一行(与现有 link `skills/agent-bridge`
并列);或改为 link 整个 skills 集。§8 验证按**真实宿主**分别测:Claude 插件态验 `agent-bridge:dev`,手动 link 态
验 `dev`——不拿 `.codex-plugin` 证明 Claude 插件态。

### 2.2 "调 dev 能不能看到 agent-bridge 的说明"

不会自动继承——skill 各自独立加载。三层处理(R1 Critical/Important:不能只靠跨引用):

- **MCP 工具本身(`agent_bridge_*`)始终可用**,与加载哪个 skill 无关(MCP server 暴露)。**但**:
  `dev/SKILL.md` 开头必须加一条**工具存在性守卫**——"若当前工具列表里没有 `agent_bridge_*`,停止并提示用户
  安装/启用 agent-bridge MCP,再继续"(工具只在 MCP server 已装/启用时才在)。
- **最小致命纪律必须内联**,不能只跨引用:在"委托机制"的关键调用点(open/wait/并行)用极简形式**重复两条最易
  翻车的规则**——`wait` 必传 `timeout_ms`、**别用 `wait:true`**(超时会 abort 本轮)。这不违反"单一真理源"
  (真理源仍在桥 skill),只是在"不照做就出事故"处做防御性重复。
- **完整机制**(return shape、textRef 关前读、mode:"any" 循环、model 纪律等)仍引用 `agent-bridge` skill:
  开头声明"先加载 `agent-bridge` skill 拿完整工具用法/并发纪律",Integration 段列为必读依赖。

## 3. 四个角色 ← superpowers 出处

| 角色文件 | 迁移自 | 人格内核(保留) | 会话默认 |
|---|---|---|---|
| `implementer.md` | subagent-driven-development/`implementer-prompt.md` | 按 spec 实现、TDD、代码组织、力不能及就升级(BLOCKED/NEEDS_CONTEXT)、汇报前自查、DONE/汇报格式 | `write:true` |
| `reviewer.md` | `requesting-code-review/code-reviewer.md` **+** `subagent-driven-development/task-reviewer-prompt.md`(合并,**两个视角都保留**) | 见下方"reviewer 双职责" | `write:false` |
| `architect.md` | brainstorming + writing-plans | 先对齐目标再动手、出 2–3 方案 + 权衡、只出方案不写实现、YAGNI、单元边界清晰 | `write:false` |
| `debugger.md` | systematic-debugging | 铁律「没根因不改**修复**代码」、四阶段(根因→模式→假设→实现)、红旗清单、根因回溯、3 次失败质疑架构 | `write:true` |

**reviewer 双职责(R1 Important:合并不能丢 task-reviewer 的验收视角)。** `reviewer.md` 必须分两块:
1. **Spec/任务符合度**(来自 task-reviewer):对照 spec/需求**逐条**核验——Missing(漏做)/ Extra(多做/过度
   工程)/ Misunderstood(做错方向);无法从 diff 判定的记为 ⚠️。
2. **代码发现**(来自 code-reviewer):按真实严重度 Critical/Important/Minor,每条 file:line 佐证,别信实现者自述。
   明确 verdict:`APPROVE / NEEDS_FIXES / BLOCKED`。

`debugger.md` 与用户 CLAUDE.md 的「追根因不打补丁」同源。write 门禁不用来管纪律——debugger 常要加诊断埋点、
写失败测试(都是写);"没根因不改修复代码"是**行为纪律**,由角色 prompt 约束,不是靠 `write:false` 卡。纯定位/
不落盘的诊断仍可 `write:false`。

**每个角色文件的结构(统一骨架):**
1. 身份与职责(你是谁、这一轮要交付什么)
2. **工作准则**(见 §4,内联的共享块)
3. 行为纪律(该角色的具体做法,取自出处)
4. 边界(不做什么;何时停下升级;**服从上层 system/user/repo 指令与工作区边界,人格不覆盖安全规则**)
5. 产出/汇报格式(最终一轮文本 = 交付物,主 agent 经 `wait`/`result` 读取)

## 4. 共享「工作准则」——内联进每个角色文件

`append_system_prompt_file` 一次只注入**一个**文件,角色文件必须自包含,不能 import。因此把这段准则**原样内联到
4 个角色文件**(约 15 行重复)。对"拿起就注入、跨项目可移植"的文件,自包含是优点。准则内容(固化用户工作原则):

- 第一性原理,拒绝经验主义/路径盲从;从原始需求出发。
- 遇问题追根因,不打补丁;每个决定能回答"为什么"。
- 评审者 ≠ 实施者(独立第二意见)。
- 不为省 token 牺牲质量;力不能及就明说、升级,不硬撑产出可疑成果。
- YAGNI:只做被要求的,不过度设计。
- 目标模糊就停下澄清,不臆测。
- 产出语言随任务/代码库(默认中文说明,代码/标识按代码库既有约定)。
- **服从上层 system/user/repo 指令与工作区边界;人格 prompt 不覆盖安全规则。**

> **一致性保障(R1/R2:防复制漂移)。** 共享块用**成对锚**界定边界:
> 开锚 `<!-- SHARED-PRINCIPLES vN — 四份复制,改一处必须同步 implementer/reviewer/architect/debugger.md -->`,
> 闭锚 `<!-- /SHARED-PRINCIPLES -->`;§8 冒烟提取**两锚之间**的 bytes,断言四个角色文件完全一致。改动时四份一起改。

## 5. 关键迁移规则(superpowers → agent-bridge)

| superpowers 原做法 | 换成 agent-bridge |
|---|---|
| `Subagent (general-purpose): model:… prompt:\|` 的 Task 派发外壳 | 去掉外壳。人格 = 角色 md,靠 `open_session(..., append_system_prompt_file=<角色>.md)` 注入 |
| "Model Selection" 章节(在 prompt 里写 model) | 移到会话级:`open_session` 的 `model`/`effort`。选择纪律见 §6.5(**按后端分支**) |
| `scripts/review-package` / `task-brief` 把 diff/brief 写成文件传给 subagent | 共享 cwd:让委托方自己 `git diff` / 读 spec 文件。**必须冻结评审范围**:prompt 里给明确 `base..head` + 路径范围 + "评审期间该范围不得变更";未提交改动要么先 commit/stash 定住,要么主 agent 保证工作区静止,并让 reviewer 记录所读范围(防 diff 漂移) |
| 只读 checkout + `git worktree` 防写 | `write:false` 会话。**注**:三后端在 `write:false` 下**仍能读**工作区文件(用 read 工具,非 shell);`write:false` 只禁写/执行,不禁读——reviewer 因此能读 diff |
| 一条消息里派多个 Task = 并行 | 多开会话,逐个非阻塞 `send_message`,`wait(mode:"any")` 收口循环 |
| `.superpowers/sdd/progress.md` ledger | 主 agent 用自己的 todo 列表跟踪 |
| subagent"汇报"= 最终返回消息 | 委托方最终一轮文本,经 `agent_bridge_wait` / `agent_bridge_result` 读取;`textRef` 取全文 |

## 6. `dev/SKILL.md`(编排指南)内容大纲

1. **前置与触发**:frontmatter description 门控(仅当要用 agent-bridge 跑委托式开发/评审;普通编码不触发);
   开头:①工具存在性守卫(§2.2)②声明依赖 `agent-bridge` skill,让 agent 先加载。
2. **角色速查表**:四个角色一句话职责 + 默认 `write` + 典型 `effort` + 角色文件相对路径。
   debugger 的 `write:true` 附一句理由:`需写诊断埋点/失败测试;不改功能性代码由行为纪律约束`。
3. **委托机制(核心循环)**:
   `open_session(agent, cwd, write, model, effort, append_system_prompt_file=<绝对路径>/roles/<角色>.md)`
   → `send_message`(非阻塞)→ `wait`(**短 `timeout_ms`,如 300000;别用 `wait:true`**,`mode:"any"`)
   → 读 `text`/`textRef` → `close_session`。关会话前先读 `textRef`。
4. **角色文件绝对路径(R1 Critical:写成可执行取法,不留隐含知识)**:
   - 角色文件在**本 skill 加载时 harness 给出的 base directory**(绝对、原生路径)下的 `roles/` 里。
     以该 base 拼 `<base>/roles/<角色>.md`。此法在插件安装态/本地/手动 link 态都成立——因为 `roles/` 随
     skill 目录一起被安装/link。
   - **传前验证**:确认解析出的是**绝对路径**且文件存在、非空(`append_system_prompt_file` 走 `readFileAbs`,
     只接受已解析好的绝对路径,不做 base 拼接/相对 fallback;拼错即 open 失败)。Windows 下 base 为 `D:\...`
     原生形态,直接可用。
   - **allow-list**:只允许四个固定角色名映射到 `roles/<名>.md`,**绝不**把用户传入的任意路径当角色文件注入。
5. **model/effort 选择(R1/R2:弹性策略,别把具体后端/模型写死)**:
   > 原则:skill 只写**选择策略**,不点名"必须用 Codex/DeepSeek"这类具体后端/模型——它们会变,以后新增 CLI/
   > 模型时点名的写法会失效或兼容性差。具体名字一律靠活查、且仅作举例。
   - **默认 → 缺了自行挑 → 拿不准问用户(核心)**:给每个角色一个**默认偏好**(按能力档 + "评审者≠实施者",
     不绑产品名);若 `doctor`/`--list-models` 显示默认不可用,agent 按同样标准**自行挑一个合适的替代**;若无法
     判断怎么挑,**停下与用户确认**,不硬凑。
     > 自行挑替代时**须遵守 §6.6 独立性规则**(reviewer 的引擎/模型 ≠ implementer 的)——与实施者相同的候选
     > 直接排除,不能因"能力档最高可用"就悄悄挑到同一个(R3 deepseek Minor)。
   - **按能力分层,不按产品名**:机械实现用低延迟/足够能力档;集成/判断用中档;架构/最终 broad review 用最强档
     (不是"最便宜",避免与"质量优先、不为省 token 缩水"冲突)。
   - **可用性/模型清单靠活查**:派活前 `agent_bridge_doctor` 看哪些后端在(当前为 omp/codex/claude,**未来新增
     CLI 同理按 doctor 结果走**);OMP 的模型清单用 `omp --list-models <关键字>`(全限定 `provider/名`),
     Codex/Claude 用后端默认或用户给定的有效模型(它们没有 `--list-models`)。
   - 具体模型 ID **不写进 skill**(会过时,见 §9 YAGNI);名字交给活查。
6. **评审独立性**:reviewer 的引擎/模型 **必须 ≠** implementer 的,才算真第二意见;新开独立会话。
7. **评审循环**:实现者(write)→ 独立评审(write:false,不同引擎)→ 按 Critical/Important 修 → 复评 →
   全部完成后一次整支 broad review。**收口后主 agent 仍须自己 `git diff` + 跑必要测试再向用户报告,不盲信委托
   agent**(与 `agent-bridge` skill 安全规则一致)。
8. **并行委托**:任务可切成独立子任务时多开会话并行;`write` 会话别撞同一批文件;同会话别并发 send。
9. **上下文卫生**:长任务降智就 close 旧 open 新,按交接物带上下文。
10. **Integration/跨引用**:显式列出依赖 `agent-bridge` skill 与本仓 `append_system_prompt_file` 能力。
    跨引用桥 skill 用 `agent-bridge`(或 `agent-bridge:agent-bridge`)让 harness 解析,**确保插件态(`agent-bridge:dev`)
    与手动 link 态(`dev`)两种部署都能指到桥 skill**;§8 两态各测一次(R2 Minor)。
11. **示例工作流**:一个"实现一个小功能"的端到端走一遍(open implementer → wait → open reviewer(异引擎,
    write:false,给定 base..head)→ wait → 修 → 复评 → 主 agent 自查 → close)。

## 6b. 工作流与多-agent 调试(用户补充,2026-07-03)

SKILL.md 在 §6 大纲外补三块(实现已含):

- **整体工作流(主模型编排)**:显式画出"规划&分解 →(逐任务)实现→审核+测试→修复→复审→验收 → 下一任务"的闭环;
  并澄清**测试落点**——implementer(TDD+跑)+ 主模型自查(git diff+跑),**reviewer 不重跑全套**("审核测试"不是让
  评审者跑测试)。
- **选角色 + 角色→能力档默认**:方案未定→architect;已定实现→implementer;评审→reviewer(异引擎);bug→debugger。
  能力档默认(遵 §6.5 弹性策略、不绑产品名):architect / 最终整支评审→最强档;debugger 根因→最强档且 **2 个异引擎**;
  reviewer→中~最强(随 diff、异于 implementer);implementer→中~最强(机械转录用低延迟档)。**注入铁规**:每次开角色
  会话必须 `append_system_prompt_file` 注入角色文件,否则委托 agent 无身份。
- **架构设计:多轮讨论(用户明确要求,需用户确认后开启)**:架构/方案默认是一场多轮讨论而非单发。主模型牵头,
  **默认拉 claude code(`model:"opus"`,`effort:"xhigh"`)+ codex**(引擎互不相同)各注入 `roles/architect.md`,均
  `write:false`(只设计、并行无写碰撞)。流程:①**先与用户确认再开启**(拉 2 agent+多轮,成本高)②给两方同一份
  问题→各出方案→循环 `wait(mode:"all")`→主模型综合点分歧→回抛复用各自会话再议(逐次、别并发同会话)③**有界停止**
  (分歧已可决策/论点重复/达 3 轮上限;某方持续 timeout 则跳过并标注缺口)④主模型综合最终设计→**交用户过目确认**→
  点头后才交 implementer。使用场景=有多合理路径且选错代价高/不可逆高风险决策/需求需拆/独立设计二审/implementer 架构 BLOCKED;
  路径唯一或改错易回退则跳过(YAGNI)。**默认阵容是用户设定的默认偏好,仍遵 §6.5 弹性策略**(不可用→自行挑相当
  替代→拿不准问用户),非硬编码。claude backend 透传 `--model`(`agent-bridge.mjs:2639`),opus+xhigh 已实测可开可跑。
- **调试:主模型 + 2 个异引擎 agent 并行根因**(用户明确要求):
  1. 主模型固化现场(复现/错误/最近改动/证据)→ 同一份任务给两个 agent。
  2. **并行独立调查 `write:false`**(两个写会话会撞文件;需埋点则主模型统一加一次再喂回)——open 2 个 debugger、
     **异引擎**(如 codex + deepseek)、各注入 `roles/debugger.md`,`wait(mode:"all")`。
  3. 主模型比对根因:一致=高置信,分歧=真问题所在。
  4. **单一 writer** 修复(避免并行写碰撞)→ 5. 走评审循环 + 主模型自查。
  按 bug 规模伸缩(YAGNI):一眼可见根因的不必兴师动众。

## 7. 语言

角色文件与 SKILL.md 用**中文**(与现有 agent-bridge SKILL.md、用户语境一致);角色文件含一行"产出语言随
任务/代码库"。

## 8. 验证(如何算做成了)

- **结构**:`skills/dev/SKILL.md` + `roles/{implementer,reviewer,architect,debugger}.md` 就位;frontmatter
  合法(`name: dev` + description)。
- **共享准则一致性**:脚本提取四个角色文件**成对锚 `<!-- SHARED-PRINCIPLES … -->` … `<!-- /SHARED-PRINCIPLES -->`
  之间**的 bytes,断言四份 byte-identical(§4)。
- **可注入性(冒烟)**:对每个角色文件做**接受性检查**——open_session 注入其绝对路径,断言解析出的路径存在、非空、
  被桥接受(summary 回显 `file=realpath`/`bytes>0`/`mode=system`)。行为 honor(后端遵从注入文件)由
  `e2e-append-system.mjs` 对任意文件、三后端已证,不在此重复。
- **命名空间/发现**:确认 **插件安装态** `/agent-bridge:dev` 能唤起;**手动/Codex 态**按更新后的 README link
  `skills/dev` 后 `dev` 能唤起(§2.1 矩阵两态都验)。
- **无回归**:现有 `agent-bridge` skill 与既有 e2e 不受影响(未改产品代码)。

## 9. 明确不做(YAGNI)

- 不迁 superpowers 脚本/ledger 基础设施。
- 不硬编码具体模型 ID(会过时;交给 §6.5 的按后端选择纪律)。
- 第一版只做四个角色(固定 allow-list);将来若需 `ops`/`research` 等,按同样机制再加(它们也引用同一份桥机制
  真理源)。
- 不改 `scripts/agent-bridge.mjs`。

## 10. 交付物清单

- `skills/dev/SKILL.md`
- `skills/dev/roles/implementer.md`
- `skills/dev/roles/reviewer.md`
- `skills/dev/roles/architect.md`
- `skills/dev/roles/debugger.md`
- README 更新(§2.1:方法 C 增加 link `skills/dev`)
- 冒烟验证 + 共享准则一致性检查(见 §8)
- 本设计文档

## 附:双评(codex + deepseek)+ 用户意见 采纳记录

| # | 级别 | 位置 | 处置 |
|---|---|---|---|
| 命名空间只在插件态成立 | Critical(codex) | §2.1 | 采纳:加安装/发现矩阵 + 改 README |
| 角色文件绝对路径取法留了隐含知识 | Critical(双) | §6.4 | 采纳:写成可执行取法(harness base dir)+ 传前验证 + allow-list |
| 只靠跨引用不可靠,最小纪律要内联 | Critical(codex)/Imp(deepseek) | §2.2 | 采纳:工具存在性守卫 + 两条致命纪律内联 |
| reviewer 合并丢了 task 验收视角 | Important(双) | §3 | 采纳:reviewer 双职责(Spec 符合度 + 代码发现) |
| reviewer 读 diff 需冻结范围 | Important(codex) | §5 | 采纳:给定 base..head + 范围不得变更 |
| write:false 能否读文件需澄清 | Critical(deepseek) | §5 | 采纳:注明 write:false 只禁写/执行不禁读 |
| model/effort 把 OMP 经验泛化过头 | Important(codex) | §6.5 | 采纳:按后端分支;"便宜"→"低延迟/足够能力" |
| 内联准则缺一致性保障 | Minor(codex)/Imp(deepseek) | §4/§8 | 采纳:锚注释 + 冒烟里 byte-identical 断言 |
| 委托后主 agent 自查纪律未迁 | Minor(deepseek) | §6.7 | 采纳:加"主 agent 仍自 git diff + 测试" |
| debugger write:true 需理由 | Minor(双) | §6.2 | 采纳:速查表加理由 |
| 角色文件安全声明/allow-list | (codex) | §3/§4/§9 | 采纳:角色文件加"服从上层指令"行 + 固定 allow-list |
| **R2** 矩阵混发现依据(拿 .codex-plugin 证明 Claude 插件) | Critical(codex) | §2.1 | 采纳:按真实宿主拆分,注明 Claude 按约定发现、与 .codex-plugin 无关 |
| **R2** 共享块缺闭锚 | Important(codex)/Minor(deepseek) | §4/§8 | 采纳:加 `<!-- /SHARED-PRINCIPLES -->` 闭锚,§8 提取两锚之间 |
| **R2** 跨引用需两种部署态都解析 | Minor(deepseek) | §6.10 | 采纳:用 `agent-bridge` 让 harness 解析,两态各测 |
| **用户** 别把 Codex/DeepSeek 写死 | 用户指令 | §6.5 | 采纳:默认→缺了自行挑→拿不准问用户;按能力档不绑产品名;名字靠活查 |
