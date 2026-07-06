---
name: agent-bridge-roundtable
description: 用 agent-bridge 组织一场「agent 圆桌审议」——主 agent 当主席,拉起 N 个不同引擎的独立 agent 多轮讨论一个问题,动态判断发言顺序与何时终结,过程用文件承载,可选启一个预置的 web 服务实时可视化,遇到只能人拍板的取舍就停下问用户。仅当用户明确要求「圆桌/多 agent 审议/多方讨论收敛」时使用;普通编码、单 agent 能答、2 席够用的方案二审不要触发。依赖 agent-bridge skill 与其 MCP 工具。
---

# Agent Bridge · Roundtable(圆桌审议编排)

把一个问题交给 **N 个真正独立的 agent** 多轮审议,由你(主 agent)当**主席**:调度谁发言、判断何时收敛、把各方意见综合成方案、遇到该人定的取舍就停下问用户。全程中间产物走**文件**,可选启一个**预置零依赖的 SSE 服务**实时看进展。

> **这是一场「匿名圆桌」**:收敛轮各席**看得到彼此的完整论证**(能直接交锋、抓对方细节),**只是看不到是谁说的**——交锋发生在**论证层**,不在**身份层**。「去权威(匿名)」压附和,但**不靠「去信息」**(不给有损摘要)。详见 §信息传递。

> **本 skill 只讲「怎么组织一场圆桌」。桥本身的机制/纪律是另一份真理源(见前置)。**
> **它相对「单 agent」「现成 2-agent 讨论」的唯一增量价值 = 动态调度 + N>2 独立视角 + 对抗式收敛(反假共识) + 可视化。不需要这些就别开圆桌(见 §何时开)。**

## 前置(务必先看)

1. **工具存在性守卫**:当前工具列表里**没有** `agent_bridge_*` 工具就**停下**,提示用户先安装/启用 agent-bridge MCP 服务器。
2. **先加载桥 skill 拿完整用法**:本流程建在 agent-bridge 之上。**先加载 `agent-bridge` skill**(手动 link 态名为 `agent-bridge`,插件态 `agent-bridge:agent-bridge`,让 harness 解析),它有完整工具用法、返回 shape、并发纪律、`textRef` 关会话前读、`contextUsage` 阈值、`doctor`/`omp models` 探测、`append_system_prompt_file` 注入角色等。本文件只在关键处**重复两条最致命纪律**。
3. **两条致命纪律(内联,别只靠跨引用)**:
   - `agent_bridge_wait` **必须传 `timeout_ms`**(如 `300000`≈5 分钟短轮询循环),**不传默认死等 30 分钟**。
   - **别给 `send_message`/`open_session` 传 `wait:true`**——超时会 **abort 掉那轮 turn**(任务被中断)。用非阻塞 send + 短超时 `wait` 收口。

## 关键事实(别踩坑)

- **桥不替圆桌记事件**。agent-bridge 只写 per-session 原始 `.log` / `bridge.log` / `exit-journal`;仓库根若有 `run.log.jsonl` 那种 `step:succeeded` 流,是**别的 OMP workflow runner** 产出的,不是 MCP 桥。**圆桌的 `transcript.jsonl` 必须你(主席)自己 append**(见 `EVENTS.md`)。
- **各席看不到彼此的身份,但(收敛轮)看得到彼此的完整论证**。独立性的来源是 **盲发 round0 + 匿名 + 异引擎 + 红队**,**不是**藏内容——别把「内容不可见」当成「独立性的来源」(那是概念错误)。所以收敛轮各席读的是**完整论证、但不知是谁**(`rounds/`,见 §信息传递),不是主席的有损摘要。**匿名在源头做**:各席出生即匿名,主席只把桥落好的发言原样 `cp` 进 `rounds/`(字节直传、零改写)、建分歧索引、记 coverage——**不转写论点实质**。
- **主席 = 你,不占参会席**。你保持中立才能公正判收敛、抓假共识;你不下场持某一方立场。但你不是哑路由——综合阶段可以「主席注记」补一个谁都没提的考量(completeness critic)。

## 何时开圆桌(YAGNI,先过这道闸)

**值得开**(同时满足多条才对):高风险 + 解空间宽(≥2 条合理路径)+ 选错代价高/不可逆 + **有 ≥3 个真正不同视角能带来增量** + 触及数据模型/公共 API/并发/框架选型/跨模块契约,或用户明确要求「圆桌/面板/多方审议」。

**别开**(用更短的路):路径清楚 / 局部改动 / 改错易回退 / 单 agent 能答 / 2 席够 → 用 `agent-bridge-dev` 的「架构设计:多轮讨论」(2-agent)或直接单 agent。**圆桌是重武器,别用来敲图钉。**

## 阵容与角色

- **主席**:你。调度、策展简报、判收敛、指派红队、人在环升级、综合终稿、**写 `transcript.jsonl`**。
- **参会席(N 席,默认 3)**:每席一个 `open_session`,注入 `panelist` 角色(见下)。**默认 `access:"read"`**(读+执行,自带 shell 可调查);只有要改工作区代码的席才 `access:"write"` + git worktree——见 §席位权限。
- **引擎/模型多样性 = 独立性的根**:先 `agent_bridge_doctor` 看后端(omp/codex/claude),给每席分**不同引擎**;引擎数 < 席数时在同引擎内换 `model`(用你的 shell 跑 `omp models <关键字>` 拿全限定 `provider/名`)。**凑不出 N 席的多样性就把 N 压到可用多样性并告知用户**——不拿同引擎同模型的克隆冒充独立视角。独立席 < 2 → 问用户是否降级(2 席都没有就不成圆桌)。
- **角色注入(铁规)**:每席开会话必须 `append_system_prompt_file=<base>/roles/panelist.md`(绝对路径、存在、非空)。`<base>` = 本 skill 加载时 harness 给出的 base directory,拼 `<base>/roles/panelist.md`。
  - **领域圆桌可换注入**:纯架构议题可换 `agent-bridge-dev/roles/architect.md`,调试议题换 `debugger.md`——圆桌是「角色无关原语」,吃一个 role 参数给每席注入对应文件。**默认 = panelist**(它自带审议纪律 + 反谄媚,architect 是单发设计者人格,缺这些)。

## 席位权限:默认 `read`(读+执行),改代码才 `write`+worktree

参会席默认 `access:"read"`——**读文件 + 搜索 + 跑 shell 命令**(read 档自带 shell,见桥 skill)。这一档够绝大多数圆桌:审议席读文档 + 推理;要调查的席还能**跑测试/复现/探针命令**——不必为"跑个命令"就开写。`read` **无 Edit/Write 工具**,意图是"不改文件";其写边界因后端而异——**codex 硬**(read-only OS 沙箱,shell 里写盘被拦)、**omp/claude 软**(shell 能写盘,靠角色纪律)。

**只有要真正改工作区代码的席才 `access:"write"`**(改源码做实验、写要保留的复现脚本/失败测试)。write 席用 **git worktree 硬隔离**(而非软纪律):`write` 在工具层是整个 cwd 可写、并发写会互相踩;每个 write 席在**自己的 worktree** 里跑,写代码互不碰撞、主工作区不脏。

**worktree 硬隔离「写」,不隔离「读」——这条要认清**:
- ✅ **写 = 硬隔离**。独立 git 工作树,写 tracked 文件互不碰撞;主工作区不受影响(worktree 在 gitignore 的 `.roundtable/` 下,main `git status` 不脏)。根治并发写腐蚀。
- ⚠️ **读 = 非硬隔离**。桥不做 OS 沙箱——有 shell 的席(**含所有 `read` 席**)技术上能 `../..` 读到主工作区的真相源(`transcript.jsonl` 的身份映射、别席 `rounds/`)。**匿名/读隔离靠 worktree 做不成硬的**——靠 `panelist.md` 角色纪律(别遍历真相源)+ **出生即匿名**(见 §信息传递)。真·硬读隔离需桥加 OS 沙箱,不在本 skill。

**worktree 生命周期**(主席用自己的 shell 跑 git,非 MCP 工具;worktree 放 `<cwd>/.roundtable/wt/<rtId>/`,run-dir **外**):
1. **建**(round 前,对每个 write 席):**先定基线**——worktree 基于 **HEAD** 拿不到未提交改动;若调查目标恰是未提交 diff,主席先 `git commit`/`stash` 定住(或 `git apply` 进各 worktree)并记录"各席对着 HEAD/某提交"。`git worktree add <cwd>/.roundtable/wt/<rtId>/seat-<x> -b rt/<rtId>/seat-<x>` → 该席 `open_session(cwd=<worktree 绝对路径>, access:"write", 注入 panelist.md)`。
2. **喂**:worktree 里**没有**主 run-dir 的 `rounds/`;**默认把简报 + 相关 `rounds/` 全文 inline 进 `send_message` 的 message**。内容大才落 `<worktree>/.rt-inbox/`,固定结构 `.rt-inbox/briefs/rN-brief.md` + `.rt-inbox/rounds/<pK>-r<N>.md`,并把简报**绝对路径**告诉该席。
3. **收**:该席**发言文本**由主席经 agent-bridge 收口、`cp` 进主 run-dir `rounds/`;**代码改动**留在 worktree,不进真相源。
4. **结束(必做,二选一)**:**移除**(默认)`git worktree remove --force <worktree>` + `git branch -D rt/<rtId>/seat-<x>`;或**合并**(仅当代码要**落地保留**)——worktree 内**只 `git add <明确代码文件>`,绝不 `-A`/`.`**(否则把 `.rt-inbox/` 里别席匿名全文提进主干)→ `git commit` → 主树 `git merge`(或交 `agent-bridge-dev` 走正式评审)→ `git worktree remove --force`。
5. **兜底清理**:异常中止也把 `wt/<rtId>/` 下所有 worktree `remove --force` + 删分支 + `git worktree prune`。

**前提 / 降级**:worktree 需 `cwd` 是 **git 仓库**;非 git 仓库无法用 → 该议题不开 write 席(退回纯 `read` 审议)或停下问用户。**主席仍是 `transcript`/`rounds`/`briefs` 唯一 writer**;写席 worktree 只装它自己的代码产物。

## 运行目录与事件契约

一场圆桌 = 一个运行目录,**主席是真理源(`transcript.jsonl`/`briefs/`/`rounds/`)的唯一 writer**(write 席在自己的 git worktree `<cwd>/.roundtable/wt/<rtId>/seat-<x>/` 里改代码,见 §席位权限)。默认 run-dir `<cwd>/.roundtable/rt-<id>/`(`<id>` 用时间戳+短随机;不塞进 `.agent-bridge/` 以免与桥 STATE_ROOT 混淆)。

- **首次运行确保 `.gitignore` 有一行 `/.roundtable/`**(消除 git 噪声);没有就加。
- 事件写进 `transcript.jsonl`(**单条 append-only,真理源**);每席每轮的完整发言旁挂 `rounds/p<K>-r<N>.md`(出生即匿名、字节直传),事件里只留引用与元数据(`roundRef`/`charCount`)。**完整 schema 与目录布局见 `EVENTS.md`(与本文件同目录),别自己另发明字段。**
- **关键:关某席前先 `cp` 该轮 `textRef` 到 `rounds/p<K>-r<N>.md`**(桥的 `textRef` 在 `close_session` 后会被删;`cp` 是字节直传、0 token——**别重新输出该席的话**)。`cp` 后 grep 引擎名黑名单兜底(§信息传递)。这一份**既是审计原件、又是别席收敛轮读的材料**(生来无身份);`p<K> ↔ 席位 ↔ 引擎` 映射只在 transcript。
- run-dir 是**给人回看的产物,不自动删**;需要就提示用户清理。

## 整体流程(主席编排循环)

```
1. 议定范围:doctor → omp models → 定 N 席 + 各自引擎/model(保多样性)。范围模糊先问用户澄清(§人在环)。
2. [提示用户] 一次性问「要开可视化实时看进展吗?(默认否)」→ 同意才起服务(§可视化)。
   建 run-dir + 写 .gitignore 一行 + append run:started。
3. Round 0 盲发并行:每席 open_session(`access` 按 §席位权限:默认 `read` / 改代码 `write`+worktree, 注入 panelist.md) → 逐个非阻塞 send 同一份中立框设
   → wait(mode:"all"|"any", timeout_ms:300000) 循环收口 → **主席**读各席输出、**关席前** `cp` 其 textRef → `rounds/p<K>-r<N>.md` + grep 泄漏兜底(§信息传递)→ append turn:produced(带 roundRef)。**席位只产出文本、从不自己写 run-dir**。
4. 主席读齐 → 抽①共识②活跃分歧③盲区 → append disagreement(匿名)→ 判是否需人(§人在环)。
5. Round r 收敛:**append `coverage`(上轮每席标 included/parked/irrelevant + 理由)** → 写 briefs/rN-brief.md(**分歧索引 + 指向 rounds/ 全文**,§信息传递;小索引可 inline 进 message)→ **append `round:started`(mode/plannedSpeakers/rationale)** → append turn:assigned(带 briefRef)
   → 相关席 read 简报 **+ 按需读它指向的 rounds/ 全文** + 追问(复用其会话,同会话不并发 send)→ 指派红队探针席反驳成形共识(读被攻击立场的完整匿名论证,§反谄媚)
   → wait 收口 → **主席** `cp` textRef → rounds/ → append turn:produced(带 roundRef)→ append schedule:decision(带 rationale)。
6. 终结条件命中(§终结)→ 主席综合(可加主席注记)→ 写 final.md + append run:final → append run:terminated。
7. 逐个 close_session(关前已 `cp` 落 rounds/)→ 停可视化(§可视化)→ 主 agent 自查后向用户报告终稿。
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

## 信息传递:出生即匿名 + 字节直传(§核心 —— 决定圆桌是「独立审议」还是「回声室」)

**关键原则:解耦「去权威」和「去信息」——保前者,砍后者。** 反谄媚靠 **匿名 + 盲发 round0 + 异引擎 + 红队**;信息**不该**为反谄媚牺牲。收敛轮各席读**其他席的完整论证、但不知是谁**——能抓对方细节、能核对主席没曲解。**内容一个字节都不经主席改写**:主席只搬运、索引、记账,从不转写论点。

**怎么做到「匿名 + 保真 + 零改写」——三件事,主席都不碰内容实质**:
1. **出生即匿名**:每席开会话就注入(`panelist.md`)「你是匿名参会者,全程不得透露引擎/模型/厂商、不得用暴露引擎的自指(如『作为 X…』)」。**产出在源头就匿名**——不存在事后"去身份改写"这道会失真的工序。
2. **字节直传(不是转写)**:桥每轮把该席完整发言原样落成 `textRef`(`fs.writeFileSync`,`read` 档也照落——`write` 只限工具层、不挡桥落盘)。主席**关席前**一条 shell `cp "<textRef>" "<run-dir>/rounds/p<K>-r<N>.md"`——**字节级一致、0 token、0 失真**;主席**不重新输出**该席的话(省 token + 杜绝转写走样)。这一份 `rounds/p<K>-r<N>.md` 既是**审计原件**、又是**别席收敛轮读的材料**(它生来无身份,不用两份)。
3. **确定性泄漏扫描(校验,不是改写)**:`cp` 后主席对该文件 grep 一个**模型/厂商名黑名单**——**按本场 `seats` 的实际 `agent`/`model` 派生**(把在场引擎/模型名加进去)+ 常见厂商/商品名(claude/opus/sonnet/gpt/chatgpt/deepseek/gemini/qwen/anthropic/openai/minimax/kimi…),**整词匹配**(`grep -iwE` 或 `\b…\b`)——**别用裸子串**,否则会误伤正文(如 "omp" 命中 component/compare);也**别放后端名 `omp`**(那是桥后端、席位不会自称它)。命中才让**该席**重述一句、或主席做**点状**遮盖——删掉意外泄漏的身份,不是改写论证。绝大多数 grep 空、直接过。

**主席每收敛轮还做两件(都只索引/记账,不复述实质)**:
- **建分歧索引 + 框任务**:写 `briefs/rN-brief.md`——每个本轮该咬的分歧一行**中立标签** + **指向相关 `rounds/` 全文的指针**(立场 A → `rounds/p2-r0.md`、立场 B → `rounds/p3-r0.md`)+ 明确任务(先 steelman 对方最强形式,再反驳/收敛/标真取舍)。**主席只索引、不复述实质**——实质由匿名全文承载,主席**无从曲解**。小索引可直接 inline 进 `send_message` 的 message,大了才落 `briefs/` 文件。
- **coverage 记账(治「无声漏点」)**:append 一条 `coverage` 事件,把上一轮**每席**发言标 `included`/`parked`/`irrelevant` + 一句理由。让「主席漏掉某席整条视角」变成**可审计的显式决策**(红队/人可质问「凭什么把 X 判无关」)。

**身份映射只在 transcript**:`p<K> ↔ 席位 ↔ 引擎` 的对应只写在 `transcript.jsonl`(`turn:produced.seat`=`p<K>` + `agent`/`model`)。`rounds/` 和 `briefs/` 里只有不透明 `p<K>`、无引擎——它们是给**席位**读的。**可视化面向人类观察者(主席/用户),会显示各席的 `agent/model` 标签**:**匿名是席位之间的**(反谄媚针对席位互评,不针对旁观的人;席位不接触 viz),所以 viz 显示引擎不破坏匿名。

**收敛轮一律「匿名全文」——不设有损档位**。出生匿名已让全文可安全共享,**不需要也不该**让主席退回「给个中立摘要」那种有损路径(那正是本次重构要根除的)。唯一的调度变体是 **debate**:某分歧卡在需逐条对轰的技术点时,开一轮双方互读对方匿名全文连续对质——这只是**普通收敛轮的调度模式**(写进 `schedule:decision.rationale`),不涉及任何改写或降信息。**不做用户必填的可见性档位**;用户有强先验时可在 `run:started` 给可选 `visibilityHint`(自由文本,主席据此框题,**仍不改写内容**)。

> 一句话:**各席看得到彼此的完整论证(能抓细节、能核对主席没曲解),只看不到是谁说的。内容零改写——主席只 `cp` 搬运、建索引、记 coverage。去权威 ≠ 去信息。**

> **残余诚实交代**:①出生匿名挡不住**写作风格泄漏**(弱身份线索),`panelist.md` 明令各席**无视风格猜测**——这是弱信号 × 弱效应,不值得为它退回有损摘要(全文匿名对所有分歧一视同仁)。②`read` 席有 shell,技术上能遍历读到 transcript 的身份映射——匿名是**出生匿名 + 角色纪律**,不是 OS 硬隔离(桥无沙箱);真·硬隔离需桥层面加沙箱,不在本 skill。

## 反谄媚 / 防假共识(LLM 圆桌最大暗礁,专门设计)

- **Round 0 盲发并行**(无锚定)。
- **红队探针**:收敛轮里主席**指派至少一席专门反驳正在成形的共识**(「这是领先方案,找它最强的失效模式」;红队**读被攻击立场的完整匿名论证**,弹药更足),并**轮换扮演者**。这是对抗式 verify 的圆桌版。
- **引擎/模型多样性**(谄媚倾向不在异引擎间同构共享)。
- **匿名全文 + 中立分歧索引**(见 §信息传递):去权威(匿名)压附和,不靠"去信息"(有损摘要)——各席看得到彼此完整论证,只看不到是谁。
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
| **并发写腐蚀** | 单 writer=主席写 JSONL;各席默认 `read`(无 Edit/Write 工具);要改代码的 write 席**各在自己的 git worktree**(写硬隔离:互不碰撞、主工作区不受影响;读非硬——无 OS 沙箱,详见 §席位权限);结束 remove 或 merge |
| **孤儿 viz** | 自灭看门狗 + viz.pid + close 时显式 kill(见上) |
| **假共识** | 红队探针 + 盲发 round0 + 引擎多样性(见上) |
| **上下文腐化** | 某席 `contextUsage.tokens ≥400k` → 关旧开新,交接摘要塞进新会话 initial_prompt(见桥 skill) |

## 主席自查(委托后不盲信)

各席默认 `read`(自带 shell 可调查、但无 Edit/Write);改代码的 write 席在**各自的 git worktree**里改(结束 remove/merge,§席位权限)。圆桌产出若进入实现,**仍走 `agent-bridge-dev` 的评审循环 + 你自己 `git diff` + 跑测试**再向用户报告。圆桌只负责「审议出方案(可含主动调查)」,落地交 dev。**收尾务必确认 `wt/` 下无残留 worktree**(`git worktree list` 核对)。

## 落地默认值

| 项 | 默认 |
|---|---|
| run-dir | `<cwd>/.roundtable/rt-<时间戳-短随机>/` + `.gitignore` 一行 `/.roundtable/` |
| 席位数 N | 3(独立引擎不足降到实际可用并告知;< 2 问用户) |
| 席位权限 | 默认 `access:"read"`(读+执行,自带 shell 可调查、无 Edit/Write;codex 硬只读、omp/claude 软);只有改工作区代码的席才 `access:"write"`,**每写席一个 git worktree** `<cwd>/.roundtable/wt/<rtId>/seat-<x>/`(写硬隔离/读非硬),结束 remove(默认)或 merge |
| 席位可见性 | **一律「匿名全文」**——收敛轮各席读 `rounds/` 匿名全文(出生即匿名)+ 主席分歧索引;不设有损档位(不退回主席摘要),唯一调度变体是 debate 轮(写进 `schedule:decision.rationale`);**不设用户必填档位**,用户强先验时可给可选 `visibilityHint` |
| coverage | 每收敛轮 append `coverage` 事件(上轮每条 included/parked/irrelevant + 理由),治主席无声漏点 |
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

- **依赖 `agent-bridge` skill**:完整工具用法、返回 shape、并发纪律、doctor/omp models、contextUsage 阈值都在那。跨引用用 `agent-bridge`(或 `agent-bridge:agent-bridge`)让 harness 解析。
- **依赖 `append_system_prompt_file`**(本仓 open_session 参数,注入角色 md)。
- **本 skill 自带资产**:`roles/panelist.md`(评议员角色)、`viz/serve.mjs` + `viz/index.html`(可视化)、`EVENTS.md`(事件 schema 真理源)。
