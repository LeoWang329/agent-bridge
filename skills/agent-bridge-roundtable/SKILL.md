---
name: agent-bridge-roundtable
description: 用 agent-bridge 组织一场「agent 圆桌审议」——主 agent 当主席,拉起 N 个不同引擎的独立 agent 多轮讨论一个问题,动态判断发言顺序与何时终结,过程用文件承载,可选启一个预置的 web 服务实时可视化,遇到只能人拍板的取舍就停下问用户。仅当用户明确要求「圆桌/多 agent 审议/多方讨论收敛」时使用;普通编码、单 agent 能答、2 席够用的方案二审不要触发。依赖 agent-bridge skill 与其 MCP 工具。
---

# Agent Bridge · Roundtable(圆桌审议编排)

把一个问题交给 **N 个真正独立的 agent** 多轮审议,由你(主 agent)当**主席**:调度谁发言、判断何时收敛、把各方意见综合成方案、遇到该人定的取舍就停下问用户。全程中间产物走**文件**,可选启一个**预置零依赖的 SSE 服务**实时看进展。

> **本 skill 只讲「怎么组织一场圆桌」。桥本身的机制/纪律是另一份真理源(见前置)。**
> **它相对「单 agent」「现成 2-agent 讨论」的唯一增量价值 = 动态调度 + N>2 独立视角 + 对抗式收敛(反假共识) + 可视化。不需要这些就别开圆桌(见 §何时开)。**

## 前置(务必先看)

1. **工具存在性守卫**:当前工具列表里**没有** `agent_bridge_*` 工具就**停下**,提示用户先安装/启用 agent-bridge MCP 服务器。
2. **先加载桥 skill 拿完整用法**:本流程建在 agent-bridge 之上。**先加载 `agent-bridge` skill**(手动 link 态名为 `agent-bridge`,插件态 `agent-bridge:agent-bridge`,让 harness 解析),它有完整工具用法、返回 shape、并发纪律、`textRef` 关会话前读、`contextUsage` 阈值、`doctor`/`--list-models` 探测、`append_system_prompt_file` 注入角色等。本文件只在关键处**重复两条最致命纪律**。
3. **两条致命纪律(内联,别只靠跨引用)**:
   - `agent_bridge_wait` **必须传 `timeout_ms`**(如 `300000`≈5 分钟短轮询循环),**不传默认死等 30 分钟**。
   - **别给 `send_message`/`open_session` 传 `wait:true`**——超时会 **abort 掉那轮 turn**(任务被中断)。用非阻塞 send + 短超时 `wait` 收口。

## 关键事实(别踩坑)

- **桥不替圆桌记事件**。agent-bridge 只写 per-session 原始 `.log` / `bridge.log` / `exit-journal`;仓库根若有 `run.log.jsonl` 那种 `step:succeeded` 流,是**别的 OMP workflow runner** 产出的,不是 MCP 桥。**圆桌的 `transcript.jsonl` 必须你(主席)自己 append**(见 `EVENTS.md`)。
- **各席彼此看不到对方输出**。每个委托 agent 是独立会话;所谓「圆桌对话」本质是**主席居中转述/策展**。这不是缺陷,正是独立性的来源。
- **主席 = 你,不占参会席**。你保持中立才能公正判收敛、抓假共识;你不下场持某一方立场。但你不是哑路由——综合阶段可以「主席注记」补一个谁都没提的考量(completeness critic)。

## 何时开圆桌(YAGNI,先过这道闸)

**值得开**(同时满足多条才对):高风险 + 解空间宽(≥2 条合理路径)+ 选错代价高/不可逆 + **有 ≥3 个真正不同视角能带来增量** + 触及数据模型/公共 API/并发/框架选型/跨模块契约,或用户明确要求「圆桌/面板/多方审议」。

**别开**(用更短的路):路径清楚 / 局部改动 / 改错易回退 / 单 agent 能答 / 2 席够 → 用 `agent-bridge-dev` 的「架构设计:多轮讨论」(2-agent)或直接单 agent。**圆桌是重武器,别用来敲图钉。**

## 阵容与角色

- **主席**:你。调度、策展简报、判收敛、指派红队、人在环升级、综合终稿、**写 `transcript.jsonl`**。
- **参会席(N 席,默认 3)**:每席一个 `open_session`,`write:false`,注入 `panelist` 角色(见下)。
- **引擎/模型多样性 = 独立性的根**:先 `agent_bridge_doctor` 看后端(omp/codex/claude),给每席分**不同引擎**;引擎数 < 席数时在同引擎内换 `model`(用你的 shell 跑 `omp --list-models <关键字>` 拿全限定 `provider/名`)。**凑不出 N 席的多样性就把 N 压到可用多样性并告知用户**——不拿同引擎同模型的克隆冒充独立视角。独立席 < 2 → 问用户是否降级(2 席都没有就不成圆桌)。
- **角色注入(铁规)**:每席开会话必须 `append_system_prompt_file=<base>/roles/panelist.md`(绝对路径、存在、非空)。`<base>` = 本 skill 加载时 harness 给出的 base directory,拼 `<base>/roles/panelist.md`。
  - **领域圆桌可换注入**:纯架构议题可换 `agent-bridge-dev/roles/architect.md`,调试议题换 `debugger.md`——圆桌是「角色无关原语」,吃一个 role 参数给每席注入对应文件。**默认 = panelist**(它自带审议纪律 + 反谄媚,architect 是单发设计者人格,缺这些)。

## 运行目录与事件契约

一场圆桌 = 一个运行目录,**你是唯一 writer**。默认 `<cwd>/.roundtable/rt-<id>/`(`<id>` 用时间戳+短随机;不塞进 `.agent-bridge/` 以免与桥 STATE_ROOT 混淆)。

- **首次运行确保 `.gitignore` 有一行 `/.roundtable/`**(消除 git 噪声);没有就加。
- 事件写进 `transcript.jsonl`(**单条 append-only,真理源**);大产出旁挂 `outputs/`,事件里只留 `outputRef`+`charCount`。**完整 schema 与目录布局见 `EVENTS.md`(与本文件同目录),别自己另发明字段。**
- **关键:关某席前先把该轮 `textRef` 内容落到 `outputs/seat-<x>-r<N>.md`**(桥的 `textRef` 在 `close_session` 后会被删)。
- run-dir 是**给人回看的产物,不自动删**;需要就提示用户清理。

## 整体流程(主席编排循环)

```
1. 议定范围:doctor → list-models → 定 N 席 + 各自引擎/model(保多样性)。范围模糊先问用户澄清(§人在环)。
2. [提示用户] 一次性问「要开可视化实时看进展吗?(默认否)」→ 同意才起服务(§可视化)。
   建 run-dir + 写 .gitignore 一行 + append run:started。
3. Round 0 盲发并行:每席 open_session(write:false, 注入 panelist.md) → 逐个非阻塞 send 同一份中立框设
   → wait(mode:"all"|"any", timeout_ms:300000) 循环收口 → 各席把 textRef 落 outputs/ + append turn:produced。
4. 主席读齐 → 抽①共识②活跃分歧③盲区 → append disagreement(匿名)→ 判是否需人(§人在环)。
5. Round r 收敛:写 briefs/rN-brief.md(§简报构造)→ append turn:assigned(带 briefRef)
   → 相关席 read 简报 + 追问(复用其会话,同会话不并发 send)→ 指派红队探针席反驳成形共识(§反谄媚)
   → wait 收口 → 落 outputs/ + turn:produced → append schedule:decision(带 rationale)。
6. 终结条件命中(§终结)→ 主席综合(可加主席注记)→ 写 final.md + append run:final → append run:terminated。
7. 逐个 close_session(关前已落 outputs/)→ 停可视化(§可视化)→ 主 agent 自查后向用户报告终稿。
```

**收口纪律**:并行发言用 `wait(mode:"any", timeout_ms:300000)` 循环(先完成先处理,`pending` 纯 id 数组当下轮 `session_ids`);要对齐比较则 `mode:"all"`。超时返回 `pendingSnapshots` 不是失败,看一眼继续 `wait`。

## 发言顺序 + 终结判定(本 skill 的智力核心)

**分轮结构**:
- **Round 0 — 盲发并行发散**:所有席**并行、互不可见**、答同一份**中立框设**。独立信号最纯的一轮(无锚定 = 反假共识的根)。
- **Round 1..k — 定向收敛**:主席抽出活跃分歧,**定向追问**:每个分歧让相关席先 steelman 对方最强论点再反驳。

**「下一个谁说」启发式**(写进 `schedule:decision.rationale`,让判断透明可复盘):
- 优先叫(a)在**高影响未决分歧**上有立场的席 /(b)对该开放问题**领域更契合**的席 /(c)**尚未被挑战过**的席。
- **轮换起始席**,别每轮同一人先说(压首因/锚定偏置)。
- **并行**:探针打**不同**分歧、互相独立时并行(压时延且保独立);**串行**:B 必须针对 A 的**具体论断**反驳时才串行,且保持定向,不搞「读完全部再泛泛表态」(那会重新引入锚定)。

**终结条件(满足任一即停,别空转)**:
- **收敛到纯取舍**:剩余分歧全是「无客观优劣的真取舍」→ **升级问人**(§人在环),别再循环。
- **重复**:连续 **2 轮无新论点**(主席判「这轮有没有引入新考量」)。
- **轮上限**:round 0 之后**实质轮 ≤3**(默认硬顶)。
- **预算上限**:`N 席 ×(1+3)轮` 为硬顶,任一维触顶 → 强制综合 + 标缺口。

## 简报构造规则(§信息传递的核心 —— 决定圆桌是「独立审议」还是「回声室」)

各席在收敛轮 **`read` 主席写的 `briefs/rN-brief.md`,不读原始 transcript**。简报怎么写决定成败:

- **争议点**:用**当事 agent 的原话/原论证**(节选,**不改写**)+ **匿名成「立场 A/立场 B」**(抹掉引擎/身份)。让各席按**论点本身**而非「谁说的/谁权威」判断——这是压附和的关键。
- **共识点**:主席一句话带过即可(没争议,失真风险低)。
- **主席只做三件事:选取(哪些分歧本轮该咬)+ 去身份(匿名)+ 框问题(附明确任务:先 steelman 再反驳)。绝不把论点实质改写成自己的总结**——那会让主席变成单点失真/偏见,各席在稻草人上互怼,毁掉独立视角。
- **可审计**:每席完整原文始终在 `outputs/`(真理源,可视化也看得到),简报只是派生视图。怀疑失真随时能调原文对照。

> 一句话:**「各席读共享文件」对,但读的是主席策展+匿名的简报,不是原始全量 transcript。** 差别就在这层策展 + 匿名。

## 反谄媚 / 防假共识(LLM 圆桌最大暗礁,专门设计)

- **Round 0 盲发并行**(无锚定)。
- **红队探针**:收敛轮里主席**指派至少一席专门反驳正在成形的共识**(「这是领先方案,找它最强的失效模式」),并**轮换扮演者**。这是对抗式 verify 的圆桌版。
- **引擎/模型多样性**(谄媚倾向不在异引擎间同构共享)。
- **简报中立呈现**、匿名(见上)。
- **辨真收敛 vs 礼貌投降**:某席翻转立场时,追问「为何对方论点是决定性的」——给得出真实理由才算收敛,只会附和 = 假共识,不计入收敛。

## 人在环升级(该人定的停下问)

**何时问人**(用 `AskUserQuestion`):
- **无客观优劣的取舍**(成本 vs 速度、UX 口味、产品优先级)——只有用户能拍。
- **不可逆/高风险**(数据模型、公共 API、安全姿态、框架选型)。
- **需求本身在讨论中暴露的歧义** → 澄清,不臆测。
- **僵局**:各席都 steelman 过仍在价值判断上分歧、再论证也不会动 → 升级而非空转。
- **不该问**:席位能靠论证/事实客观解决的技术问题——在盘内解决,别浪费用户。

**如何进事件流**:append `human:asked`{questionId,question,options,why} → 可视化挂「⏸ 等待人类决断」→ 调 `AskUserQuestion` → 得答后 append `human:answered`{questionId,answer} → 把该决定**作为约束注入下一轮简报**。

## 可视化(常驻轻服务 + SSE,预置零启动成本)

**形态**:`<base>/viz/serve.mjs` 是**预置、零依赖、零构建**的单文件 node 服务(仅 Node 内建)。**每次运行零 token 生成**,启动只是一条命令 + 读一行 stdout——这就是「近零启动成本」与「实时体验」的调和:成本低因为**不每次现造服务**,实时因为**造好的常驻进程持续 SSE 推**。

**默认关,一次性提示**:范围议定后、round 0 前,用 `AskUserQuestion` **问一次**「要开可视化吗?(默认否)」,别反复叨扰。用户不要就整场跳过。

**起**(用户同意后,你的 shell 跑,非 MCP 工具):
```
node <base>/viz/serve.mjs <run-dir>
```
- 抓 stdout 里 `ROUNDTABLE_URL=http://127.0.0.1:<port>` 这行,把 URL 转告用户。
- **务必先写 `run:started` 再起服务**(服务靠轮询 transcript.jsonl,文件得先在)。用后台方式跑(别阻塞主 agent),记下 URL。
- 服务只绑 `127.0.0.1`、端口占用自动回退、内联前端无外链、`/file` 防目录穿越且只读——安全边界已在服务内实现。

**停(防孤儿,三重保险)**:
1. **自灭看门狗**(服务内建):transcript 出现 `run:terminated` 且最后一个页面断开 + 宽限 60s → 自退;始终无人连满 10 分钟 → 兜底自退。**即使你忘了,服务也会自我回收。**
2. 服务把 pid 写 `<run-dir>/viz.pid`;圆桌 close 时你**显式 kill 该 pid**(兜底)。
3. pid 已记 → 崩溃后也好清理(同桥 `cleanup` 思路)。

## 失败模式 / 降级(呼应桥教训)

| 失败 | 兜底 |
|---|---|
| 某席 **wait 超时** | `wait` 返回 `timedOut/pendingSnapshots`——**不 abort**;有界重试 `wait`;持续超时 → append `seat:skipped` **跳过该席**,综合标缺口 |
| 后端**挂/被关** | `wait` 返回 `failed/closed` → 当掉线席;**存活独立席 < 2** → 降级问用户 |
| **不收敛** | 命中轮上限 → 强制综合 + 显式「未决:X」+ 残余升级问人 |
| **成本失控** | 预算触顶 → 停 + 综合部分结果 |
| **并发写腐蚀** | 单 writer=主席写 JSONL;各席全程 `write:false` 永不写转录;真要写代码交回 `agent-bridge-dev` 的 implementer/reviewer 流程 |
| **孤儿 viz** | 自灭看门狗 + viz.pid + close 时显式 kill(见上) |
| **假共识** | 红队探针 + 盲发 round0 + 引擎多样性(见上) |
| **上下文腐化** | 某席 `contextUsage.tokens ≥400k` → 关旧开新,交接摘要塞进新会话 initial_prompt(见桥 skill) |

## 主席自查(委托后不盲信)

各席只读、不改文件;但圆桌产出若进入实现,**仍走 `agent-bridge-dev` 的评审循环 + 你自己 `git diff` + 跑测试**再向用户报告。圆桌只负责「审议出方案」,不负责「落地」。

## 落地默认值

| 项 | 默认 |
|---|---|
| run-dir | `<cwd>/.roundtable/rt-<时间戳-短随机>/` + `.gitignore` 一行 `/.roundtable/` |
| 席位数 N | 3(独立引擎不足降到实际可用并告知;< 2 问用户) |
| 轮次 | round0 盲发 + 实质轮上限 3;连续 2 轮无新论点即停 |
| 预算硬顶 | N ×(1+3)轮 |
| viz 端口 | 7345,占用回退 OS 临时端口 |
| viz 自灭 | 终结后末个客户端断开宽限 60s / 始终无客户端兜底 10min |
| 角色 | 默认 `panelist`;纯架构/调试议题可换注入 dev 的 architect/debugger |

## 与 agent-bridge-dev 的边界

- **dev** = 任务型开发工作流(实现→评审→修→复评;并行调试;2-agent 架构讨论)。
- **roundtable** = 通用 N 席审议原语(动态调度、收敛、人在环、可视化),领域无关。
- **重叠处**:dev 的「架构设计:多轮讨论」是圆桌的 2 席特例。**保持 dev 那段原样**(简单、已发布、跑得通,别为通用性给常见 2-agent 场景加间接层),双向交叉引用即可,现在不合并(YAGNI)。
  - dev → 「要 N>2 席 / 动态调度 / 可视化审议 / 非开发议题」时用 roundtable。
  - roundtable → 「只要有界的 2-架构师设计讨论」时用 dev 那段。

## Integration / 跨引用

- **依赖 `agent-bridge` skill**:完整工具用法、返回 shape、并发纪律、doctor/list-models、contextUsage 阈值都在那。跨引用用 `agent-bridge`(或 `agent-bridge:agent-bridge`)让 harness 解析。
- **依赖 `append_system_prompt_file`**(本仓 open_session 参数,注入角色 md)。
- **本 skill 自带资产**:`roles/panelist.md`(评议员角色)、`viz/serve.mjs` + `viz/index.html`(可视化)、`EVENTS.md`(事件 schema 真理源)。
