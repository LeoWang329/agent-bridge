# DESIGN — `agent-bridge-loop` skill(合同驱动的自动交付循环)

日期:2026-07-06 · 状态:**已实现并双评修复**(同日;6 个用户拍板决策见 §13;dogfood 实测修正与评审修复已回写本文档与 skill)
前置阅读:`skills/agent-bridge/SKILL.md`(桥机制)、`skills/agent-bridge-dev/SKILL.md`(角色委托)、`skills/agent-bridge-roundtable/SKILL.md` + `EVENTS.md`(圆桌/事件流/viz 模式)

---

## 1. 原始需求(用户,2026-07-06,压缩转述)

用户给定一个具体任务(开发/优化)→ 主 agent 开局先确认**两件事**:①这个过程要不要人参与;②需不需要评审团做问题深挖(多架构师 / 圆桌 / 不要)。过程中有歧义就与用户确认,最好是头脑风暴/苏格拉底访谈式彻底确定需求细节。产出是**一份标准验收合同**:一个或多个 goal + 每个 goal 的验收标准,合同要交用户确认是否修改。之后拉起两个 agent:**生成者**(干活、测试、交付)与**验证者**(最终验收:端到端测试、使用系统、查日志),有问题打回生成者修,直到全部解决再进下一个 goal,确保所有 goal 搞定。借鉴 Claude 团队的 loop 工程。给验证者和生成者准备**通用、可 append 的 system prompt**。任务有时定时触发,所以要有**无人值守开关**:用户明确说不需要人参与时,直接拉评审团走完整无人 pipeline。所有迭代**留痕**,并有**可视化页面**看每一轮开发/优化的爬坡过程。

## 2. 定位与组合关系(不重造轮子)

`agent-bridge-loop` 是**闭环层**:需求挖掘复用现有评审团 skill,内环是新的「生成者/验证者」验收循环,留痕+viz 复用圆桌已验证的架构。

```
agent-bridge-loop(新)
 ├─ 需求挖掘评审团 ─┬─ 多架构师 = 复用 agent-bridge-dev「架构设计:多轮讨论」(2 席,轻)
 │                  └─ 圆桌     = 复用 agent-bridge-roundtable(N 席,重)
 ├─ 内环角色 = 新 roles/generator.md + roles/validator.md(通用可 append 的 system prompt)
 ├─ 权限    = 生成者/验证者均 access:"write";验证者会话内自给自足(自写测试脚本,不依赖桥工具),
 │            不改产品码靠「洁净树审计」而非工具裁剪(§6),验证资产进 validation/
 └─ 留痕/viz = 圆桌模式:transcript.jsonl 单 writer + serve.mjs(内容无关,直接拷贝)+ 新 index.html
```

**与 dev / roundtable 的边界**:dev = 任务型开发工作流原语(实现→评审→修);roundtable = N 席审议原语;**loop = 「从需求到全部验收通过」的端到端闭环编排**,把前两者当子程序调用。loop 的内环(生成者/验证者)**不是** dev 的实现→评审循环:reviewer 是读代码的白盒评审,验证者是**跑系统的黑盒验收**——本质不同(代码质量要保证时,把「reviewer APPROVE」写成合同里的一条 AC,由验证流程照单执行,见 §5)。

**借鉴 Claude 团队 loop 工程(长时程 agent harness)的映射**:

| loop 工程原则 | 本 skill 的落法 |
|---|---|
| 状态外置(feature list / progress 文件),不靠会话记忆 | 合同 contract.md + transcript.jsonl + git 历史 = 全部状态;任何会话可随时重开无损 |
| 一次只做一个 feature | 一次只做一个 goal,串行 |
| initializer 与 coder 分离 | Phase 1(出合同)与 Phase 2(循环交付)分离 |
| 像用户一样端到端测试 | 验证者的定义:起系统、打请求、查日志,不是读代码 |
| 每迭代干净上下文 | 验证者每轮 fresh 会话;生成者按 contextUsage≥400k 关旧开新 |
| git 做 checkpoint | 生成者每迭代 commit;验证者用 git diff 核对改动范围 |

## 3. 总流程

```
Phase 0 开局确认(两问,参数已给则不问)
  → Phase 1 需求挖掘 → 验收合同 contract.md → [合同闸:用户确认 / 无人值守由面板批判替代]
  → Phase 2 逐 goal:生成者↔验证者严格交替循环,直到该 goal 全部 AC 通过
  → Phase 3 收官:整支 broad review 闸(异引擎,APPROVE 才过)→ final.md 报告(+无人值守:branch 交付物)
全程:主 agent 单 writer 写 transcript.jsonl;viz 按需开、事后可回放。
```

## 4. Phase 0:开局两问 + 无人值守语义

进 skill 先解析调用参数,**参数里已写明的不再问**(定时触发跑通的关键):

- **问①(人参与吗)**:`人在环`(默认)/ `无人值守`。
- **问②(评审团)**:`多架构师` / `圆桌` / `不要`(主 agent 自己挖需求)。

**无人值守语义**:
- 全程零 `AskUserQuestion`。
- 评审团**强制开启**(人类闸门由面板批判替代);默认 = **双架构师**(用户拍板),调用 prompt 可点名「圆桌」覆盖。
- 本该问人的歧义 → 主 agent 拍板,决策理由写进事件流 + 合同「假设账本」;收官报告红字列出全部假设。**无人值守 ≠ 无歧义,歧义变成留痕的显式假设。**
- 工作区:**一律 git worktree + 独立 branch**(用户拍板;cron 触发时用户可能正用主树)。生成者与验证者的 `cwd` 都指向 worktree(被测代码在那)。交付物 = branch 名 + final 报告,用户事后 review 合并。worktree 建/收/兜底清理直接复用 roundtable §席位权限已验证的流程(基线=HEAD,未提交改动不进 worktree,结束 remove 或留 branch)。
- cron prompt 模板:`用 agent-bridge-loop,无人值守,评审团=架构师,任务:<描述>`。

人在环时工作区默认主树(用户在场,可随时叫停),用户可显式要求 worktree。

## 5. Phase 1:需求挖掘 → 验收合同

**人在环**:苏格拉底式访谈——一次只问一个问题、优先多选、直到目的/边界/成功标准全清。开了评审团则面板先挖盲点/风险/隐性需求,**主 agent 把面板挖出的问题转成对用户的访谈问题**——面板负责「想到该问什么」,用户负责答。

**无人值守**:面板直接对任务深挖 + 红队批判;无人可答的歧义 → 主 agent 拍板 + 假设账本留痕。

**评审团接线**:多架构师 → 按 dev skill 那段跑(claude opus + codex,architect.md,2–3 轮;无人值守时跳过该段的「先与用户确认再开启」闸——本 skill 的无人值守开关就是那个确认);圆桌 → 按 roundtable skill 跑(它有自己的 run-dir 与事件流)。loop 的 transcript 只记 `panel:launched{kind,runDir}` / `panel:concluded{summaryRef}`——解耦,不复述面板内容。

**产出 `contract.md`(本 skill 的真理源)**:

```markdown
# 验收合同 — <任务名>
模式: 人在环|无人值守 · 评审团: 双架构师|圆桌|无 · 生成: <ISO 时间>
## 原始需求(用户原话,逐字)
## 假设账本
- A1: <歧义> → 采取 <假设>(来源: 用户确认 / 面板推定+理由)
## Goal G1: <标题>
动机: <为什么要这个 goal>
验收标准(每条必须可被验证者独立执行验证):
- AC1 [test]   `npm test` 全绿
- AC2 [e2e]    启动服务后 POST /api/x 返回 200 且落库可查(给出具体命令/步骤)
- AC3 [log]    e2e 跑完后 logs/ 无 ERROR 级日志
- AC4 [review] 异引擎 reviewer 对 base..head 给 APPROVE   ← 代码质量当 AC 的写法
边界: 不动 <Y>
## Goal G2: …
## 全局约束(依赖/兼容/风格等)
```

**AC 铁规**:每条都写「怎么验」——验证者能照着执行的才算 AC;「代码质量好」这种不可执行的表述不收。合同闸前主 agent 逐条过一遍「能不能照着跑」。

**AC 执行者划分**:`[test]/[e2e]/[log]` 等可 shell 执行的 → 验证者亲手跑(含自建脚本);`[review]` 这类需要**拉起另一个 bridge 会话**的 → **主 agent 代执行**(验证者是后端 CLI 会话,没有 agent_bridge 工具),且 **lazy**——该轮其它 AC 全绿才拉 reviewer(对失败迭代跑评审纯浪费);结果并入该轮 verdict 的对应 `acResults` 条目——验收权威仍是「该轮 verdict 全绿才算过」,不因执行者拆分而多头。

**代码评审的两层(用户拍板 2026-07-06,验收验行为、评审评质量,两个轴)**:
1. **收官闸(默认,必过)**:所有 goal 通过后、`run:final` 前,对整支改动做一次 broad review(异引擎 reviewer,dev 的「整支评审」原样)。NEEDS_FIXES → 缺陷打回生成者修 → 复评到 APPROVE;修复涉及的 goal 由验证者重验受影响 AC(防修复引入回归)。无人值守同样必过——交付的 branch 绝不零评审落地。
2. **可选合同 AC(逐 goal)**:关键 goal 才写 `[review]` AC,按上面「主 agent 代执行 + lazy」跑。

**合同闸**:人在环 → 交用户过目改/确认(确认记 `contract:confirmed{by:"user"}`);无人值守 → 面板对合同做一轮批判,主 agent 采纳/拒绝逐条留痕后定稿(`contract:confirmed{by:"panel"}`)。

**中途改约(边缘)**:运行中用户改需求 → 更新 contract.md + 记 `contract:amended{changes}`;受影响的已通过 goal 标记「需复验」重进队列。

## 6. Phase 2:生成者/验证者循环(内环核心)

> **演化注记(2026-07-07)**:本内环的顶层循环目前由**模型主线程 prose 调度**。已拍板的演化方向是
> **代码写骨架、模型当关节**——机械环节(verdict 解析、洁净树审计+代 commit、事件记账、send→wait 收口)
> 抽成工具,协议稳定后把本内环写成 driver 脚本、模型退到判断关节(仲裁/BLOCKED/stuck/合同修订/收官),
> **无人值守内环最先迁**。迁移判据、三级梯子、为什么"现在别写死"见
> `docs/DESIGN-orchestration-evolution-prose-to-code-2026-07-07.md`。

goals 默认按序依赖,逐个串行。**严格交替、同一时刻只有一方活跃**(天然无并发写冲突):

```
open 生成者(write:true, cwd=工作区, 注入 roles/generator.md, 引擎按 dev §model 弹性策略)
对每个 goal:
  loop(迭代 n = 1..上限5):
    1. 生成者 ← goal 全文 + 上一轮缺陷清单(首轮为空)
       → 实现 + 自测 + git commit + 固定格式汇报
       → 主 agent cp 其 textRef → iterations/g<K>/i<n>-gen.md,记 gen:produced
    2. open 验证者(access:"write", cwd=同工作区, 引擎≠生成者, 注入 roles/validator.md)【每轮 fresh】
       ← 合同该 goal 全文 + 「逐条 AC 亲手执行验证;验证脚本放 validation/,优先复用前轮」
       → 自建所需验证资产(playwright/探针/fixture)→ 结构化 verdict:每条 AC PASS/FAIL + 缺陷(现象/证据/复现步骤)
       → 主 agent 洁净树审计:`git status --porcelain` 有 tracked 改动 → 撤销 + 记 val:tainted + fresh 重验
       → cp verdict textRef → iterations/g<K>/i<n>-verdict.md,记 val:verdict,close 验证者
    3. 全绿 → goal:passed → 下一个 goal
       有红 → 缺陷清单打回生成者(复用其会话追问)→ 回到 1
    4. 达迭代上限仍不过 → goal:stuck:
       人在环 → AskUserQuestion(继续加轮/改合同/放弃该 goal)
       无人值守 → 中止后续 goal(用户拍板;按序依赖,G1 没过硬跑 G2 多半白干),
                  final 报告红字标 stuck,已通过 goal 的成果保留
```

**关键设计决定(每条答得出为什么)**:

| 决定 | 为什么 |
|---|---|
| 验收权威唯一 = 验证者;生成者宣称「完成」不作数 | 反 reward-hacking:干活的人不能自己验收(loop 工程核心教训) |
| 验证者 `access:"write"`(用户拍板 2026-07-06) | 真 e2e 常要**自建工具**:写 playwright/探针脚本、fixture——codex 的 `read` 档是硬 OS 沙箱,连测试脚本都写不出来,等于堵死最需要自建工具的验收场景。验证者会话内**自给自足**,全部验证动作不依赖桥工具 |
| 修复权仍只在生成者:**洁净树审计**替代工具裁剪 | 每轮验证始于生成者 commit 后的洁净树 → 验证后 `git status --porcelain` 有 tracked 改动 = **verdict 污染** → 撤销 + `val:tainted` + fresh 重验。可检测、可回滚,比软纪律硬;「要改产品码才能验」本身就是缺陷,报告而非动手 |
| 验证资产专属地盘 `<工作树>/.loop/run-<id>/validation/` | gitignore `/.loop/` 已覆盖(.gitignore 是 tracked 文件,worktree 同样生效);playwright 等依赖装 validation/ **自己的** package.json,不碰产品树 package.json/lock;产品树 `npm ci` 不改 tracked 文件,允许 |
| 验证者引擎 ≠ 生成者(硬规则) | 同 reviewer 独立性:同引擎验自己的活不算第二意见 |
| 验证者每轮 fresh 会话 + **全量重验所有 AC** | 防「修 A 坏 B」回归 + 防「上轮我验过了」惰性锚定;其全部状态 = 合同 + validation/ 里前轮脚本(**外置复用,fresh 不返工**),冷启动成本≈0。跨迭代引擎保持同一个(判准一致) |
| 生成者会话跨迭代复用,`contextUsage≥400k` 关旧开新 | 修复需要上下文;交接物 = 合同 + 缺陷清单 + git log,状态全外置,重开无损 |
| 每迭代 git commit | 回滚锚点 + 验证者 `git diff` 核对改动范围没有越界 |
| commit 由主控兜底(dogfood 实测修正 2026-07-06;Win 平台差异补注 2026-07-07) | codex 的 workspace-write 沙箱在 **mac/Linux 保护 `.git/`** → 生成者 commit 被拒(如实 BLOCKED);**Windows 上 codex 走 danger-full-access(桥的 sandbox 映射,见 agent-bridge.mjs),无此保护、可自行 commit**。无论哪种,洁净树基线是主控的验收前置条件,不赖委托方自觉:生成者 commit 首选,**主控以 `git status` 兜底代 commit** |
| 迭代上限默认 5(调用参数可改) | 5 轮修不过大概率是合同/方案问题,不是再磨一轮的问题——该升级给人/中止,不是空转 |
| **AC 设计铁规**:有可观察行为的 goal 不得仅靠 `[test]` 通过(职责细化 2026-07-07) | `[test]` 跑的是**生成者自己写的**产品测试(交付物,可能空断言/漏断言)——「被考者出题」的变体。凡 goal 有用户可观察行为,必配一条**验证者亲手执行**的独立验证(`[e2e]`/`[log]`)从行为轴独立确认;纯内部重构(无新行为)可 `[test]`+`[review]`。防线放规范层(合同闸),不去让验证者白盒读测试码,黑盒纯度不破 |
| **两类"测试脚本"所有权双向锁死**(职责细化 2026-07-07) | 产品测试(unit/integration)= **生成者**写、tracked、交付物;`validation/` 里 e2e/探针/fixture = **验证者**写、gitignored、尺子执行层。互不可碰不是新规则,是既有两条铁律的副产品(验证者不动 tracked / 生成者不碰 `.loop/`) |
| **验证脚本(尺子)有 bug:发现权全开、修改权唯一 = 下轮 fresh 验证者**(职责细化 2026-07-07) | `validation/` 无洁净树审计罩着,完整性只靠**单一 writer 所有权**。生成者改=被考者改考卷(结构性禁止);主控亲手改=裁判下场兼工具作者、且两 writer 无法归因"谁改坏"。故全员只**报告**可疑,主控只把裁决证据附进下轮验证者 send,由验证者改;验证者血脉修不动 → 主控 `doctor` 换引擎重开(换人不换规则) |
| **先红后绿**:新建/改的验证脚本先对已知应 FAIL 的状态确认能红(职责细化 2026-07-07) | 一条从没红过的脚本可能什么都没测到(空断言/选择器失效/连错服务),用它判 PASS 等于放水——把 TDD「先看测试失败」移植到尺子自检,零新增会话,堵住"脚本恒 PASS"这类最常见放水 bug |
| **稳定性自检**:新建/改且碰不确定性来源的脚本,同树连跑 K=3 须结论一致(补 2026-07-08) | 先红后绿只证「有灵敏度(能红)」,漏了「稳定(好态不假红)」——脚本可能坏态能红、好态偶发假红,凭空 FAIL 冤枉生成者。判据取**最干净形式**:树不变则确定性脚本结论必一致,分叉 = 尺子在抖。分诊两种根因:①尺子自身抖(竞态/未固定种子)→ 验证者稳定它;②被测系统随机(LLM 输出)→ 属 AC 设计问题(见下行),报主控。**只对新建/改且碰不确定性来源的脚本做**(纯确定性免跑,与成本相称);K 次连跑并发 |
| **随机/LLM 行为的 AC 用配额阈值,不用单发断言**(补 2026-07-08) | LLM 输出同输入两跑就不同,单发等值断言必然 flaky——是「被测系统随机」这类假 FAIL 的根治处:AC 写成 `n 次采样 ≥m 次满足`(n/m 按业务容忍度)。放**合同设计层**(主 agent 出合同时定),否则验证者验收时被迫替出题人拍阈值;采样并发跑压墙钟 |
| **涉 LLM/慢 IO 测试并发提速**(补 2026-07-08,用户要求) | LLM 时延是墙钟大头,多个**独立**调用(配额采样 n 次 / 独立 e2e 用例 / 稳定性 K 次连跑)串行是纯浪费 → 并发(Promise.all/有界池/框架并行/`xargs -P`)。两纪律:限并发上限(防限流+防榨满机器,同桥 skill)、保样本独立(否则并发互踩造假抖动)。生成者/验证者两侧都写 |
| **自然语言质量 AC:合同给 rubric+阈值,验证者落成脚本化 LLM-judge,观感只做交叉核验**(补 2026-07-08) | gate AC 的 NL 判断若靠验证者通读观感:不可复跑(`val:script-defect` 仲裁裁无可裁)、fresh 会话间判准漂移、且是对随机 judge 的单发采样(违反配额阈值规则)、还被生成者自述锚定(脚本 judge 是盲评)。脚本化后 judge 成为**工件**,被既有所有权/先红后绿/稳定性自检全罩住;分层同构:标准在合同(rubric)、执行层在 validation/(冻结 prompt+钉死模型)、观感降级 NOTES 交叉核验。不 gate 的观察直接 NOTES(YAGNI) |
| **主控行为白名单 + 收官越界自审**(dogfood 修正 2026-07-08) | 两次独立实测 run 出现同一漂移:主控"顺手"写验证基线/亲手跑尺子/想直接修小缺陷,合理化话术高度一致(「很机械」「省上下文」「一行就能修」)——prose 编排的结构病,滑坡源头是四个被批准的动手例外(代 commit/仲裁复跑/收官抽查/代执行 review)。治法:穷举白名单五项+每项防滑坡边界+具名绊线;收官加机械自审(git log 产品 commit ↔ `gen:produced`/代提交一一映射——对客观数据没法合理化)。结构性根治指向演化文档 L3(driver 握循环后无"格子间自由人") |
| **仲裁明文化**:生成者质疑缺陷不成立 → 主控亲手复跑该 AC 复现步骤裁决(职责细化 2026-07-07) | 缺陷争议不能悬空:确成立→仍打回生成者;确不成立(尺子误判)→记验证脚本缺陷交下轮验证者修尺子。裁决者=主控,修改者仍按所有权=验证者,两权分离 |

**两条致命纪律(内联,同 dev/roundtable)**:`wait` 必传 `timeout_ms`(300000 短轮询循环);别给 `send_message`/`open_session` 传 `wait:true`(超时 abort 掉 turn)。

## 7. 两个新角色文件(`roles/`,通用可 append)

**`roles/generator.md`(生成者)**:
- 你在一个验收循环里:你的产出将被独立验证者按合同逐条验收;**永不宣称「验收通过」**(那是验证者的词),只汇报「已实现+自测证据」。
- 只对当前 goal 负责,不越界改边界外的东西。
- TDD 自测;每迭代 git commit(信息含 goal/迭代号)。
- **对缺陷清单逐条回应**:每条 fixed(怎么修的)/ 不修(为什么,如 AC 理解分歧——升级给主 agent,不擅自降标)。
- 固定汇报格式:改动文件 / 测试证据 / 遗留风险。

**`roles/validator.md`(验证者)**:
- 你是验收员,**只认合同**;逐条 AC **亲手执行**验证(跑命令、起系统、打请求、读日志),不信生成者的任何汇报。
- **全量重验**:每次验收把该 goal 所有 AC 全部重跑,不只验上轮失败项。
- 缺陷必须带证据:命令输出/日志行/复现步骤,并标涉及哪条 AC。
- **自建验证资产(鼓励)**:可以也应该自己写验证脚本(playwright/探针/fixture),一律放 `<cwd>/.loop/run-<id>/validation/`;需要的依赖装在 validation/ 自己的 package.json 下,**绝不碰产品树的 package.json/lock**;前轮脚本就在那,优先复用改进,别重写。
- **先红后绿 + 尺子所有权**(职责细化 2026-07-07):新建/改的验证脚本先对已知应 FAIL 的状态确认能红再用于验收;验证脚本(尺子)是验证者专属资产,别人只报告可疑、唯一修改者是下轮 fresh 验证者(详见 SKILL.md §尺子的所有权与修改权 / `val:script-defect` 事件)。
- **禁止**:修改产品代码(任何 tracked 文件——「要改产品码才能验」本身就是缺陷,报告它)、降低验收标准、替生成者设计具体实现(可指出方向)。
- **进程卫生**:你为验收启动的任何进程(服务/watcher)必须在验收结束前自己停掉(记 pid、kill),不留孤儿(本仓血泪教训)。
- 固定 verdict 格式(机器可解析,主 agent 据此写事件):`VERDICT: PASS|FAIL` + 每条 `AC<n>: PASS|FAIL — <一句证据>` + 缺陷列表。

不复用 implementer/reviewer 的原因:implementer 缺循环协议(缺陷清单逐条回应、永不自宣验收),reviewer 是白盒读代码,验证者是黑盒跑系统——职责不同就分文件,别往旧角色里塞开关。

## 8. 留痕:run-dir 与事件 schema

**run-dir `<cwd>/.loop/run-<时间戳-短随机>/`**(首次运行确保 `.gitignore` 有 `/.loop/`):

```
transcript.jsonl            ← 事件流真理源,单 writer=主 agent;信封同圆桌(v/seq/ts/event/runId/payload)
contract.md                 ← 验收合同(Phase 1 产出,确认后定稿)
iterations/g<K>/i<N>-gen.md      ← 生成者第 N 迭代汇报(cp textRef 字节直传,审计原件)
iterations/g<K>/i<N>-verdict.md  ← 验证者第 N 迭代 verdict(同上)
validation/                 ← 验证者自建验证资产(playwright/探针脚本+自带 package.json,跨迭代复用;
                               无人值守时活在 <worktree>/.loop/run-<id>/validation/,收官归档回主树 run-dir)
final.md                    ← 收官报告
viz.pid                     ← 开了 viz 时的服务 pid(兜底 kill)
```

评审团子运行有**自己的** run-dir(dev 讨论无 run-dir 则落 `panel/` 摘要文件;圆桌在 `.roundtable/rt-*/`),loop 只记引用。

**事件表**(完整 schema 实现时落 `skills/agent-bridge-loop/EVENTS.md`,信封与文件引用约定同圆桌 EVENTS.md):

| event | 关键 payload | 含义 |
|---|---|---|
| `run:started` | `task`,`mode:{human,panel,workspace}`,`iterCap` | 开跑:原始任务 + 三开关 |
| `intake:asked` / `intake:answered` | `question`/`answer` | 需求访谈一问一答(人在环) |
| `panel:launched` / `panel:concluded` | `kind:"architects"\|"roundtable"`,`runDir` / `summaryRef` | 评审团子运行(只记引用) |
| `contract:drafted` | `contractRef`,`goals:[{id,title,acCount}]` | 合同草案 |
| `contract:confirmed` | `by:"user"\|"panel"`,`changes?` | 合同闸通过 |
| `contract:amended` | `changes`,`affectedGoals` | 中途改约 |
| `goal:started` | `goalId`,`title`,`acCount` | 开始一个 goal(acCount 主控从合同数出,前端显示与爬坡分母) |
| `iter:started` | `goalId`,`n` | 第 n 迭代 |
| `gen:produced` | `goalId`,`n`,`genRef`,`summary`,`commit`,`filesChanged` | 生成者交付 |
| `val:verdict` | `goalId`,`n`,`verdict:"pass"\|"fail"`,`acResults:[{acId,status,evidence}]`,`defects:[…]`,`verdictRef` | 验收结果(爬坡数据源) |
| `val:tainted` | `goalId`,`n`,`files` | 洁净树审计不过:验证者改了 tracked 产品文件 → 撤销 + 该轮 verdict 作废 + fresh 重验 |
| `val:script-defect` | `goalId`,`n`,`acId`,`desc`,`evidence`,`discoveredBy` | 仲裁认定验证脚本(尺子)误判 → 留痕交下轮 fresh 验证者修尺子(纯争议轮不消耗生成者迭代配额、沿用同一 n 重验;详见 EVENTS.md 与 SKILL.md §尺子的所有权) |
| `goal:passed` | `goalId`,`iters` | goal 全绿 |
| `goal:stuck` | `goalId`,`reason:"iter-cap"\|"script-defect-loop"`,`policy:"halt"\|"user-extend"\|"user-amend"\|"user-abandon"` | 卡死:`reason`=为何卡(iter-cap=达迭代上限;script-defect-loop=尺子仲裁 >2 次不收敛);`policy`=采取的动作(halt=无人值守中止;user-* = 人在环用户选:加轮/改合同/放弃) |
| `review:final` | `verdict:"approve"\|"needs-fixes"`,`reviewRef`,`round` | 收官闸:整支 broad review(NEEDS_FIXES → 打回生成者,复评到 APPROVE 才 `run:final`) |
| `human:asked` / `human:answered` | 同圆桌 | 人在环升级 |
| `run:final` | `reportRef`,`goalsPassed`,`goalsTotal`,`branch?` | 收官(无人值守带 branch 名) |
| `run:terminated` | `reason:"done"\|"stuck"\|"user"\|"error"` | 终态(viz 自灭信号) |

## 9. 可视化(爬坡视图)

- **`serve.mjs` 直接从圆桌 viz 拷贝**(它只 tail jsonl + SSE 回放 + `/file?ref=` 防穿越,内容无关;拷贝而非跨 skill 引用——skill 目录各自 junction 分发,避免路径耦合)。**新写 `index.html`**(内联零依赖,同圆桌工程约束:seq 去重、半行缓冲、XSS 转义、reset)。
- 界面:
  - 顶部:任务 · 模式 · goals 进度(`2/3 ✅`),每 goal 一个状态徽标(待启动/进行中/passed/stuck)。
  - 每 goal 一条泳道:迭代格 i1 i2 i3…(红=fail 绿=pass 黄=进行中),点开看 gen 摘要 + 逐条 AC 结果 + 缺陷(证据按需 `/file` 拉全文)。
  - **爬坡曲线(核心诉求)**:每 goal 一条「AC 通过数随迭代」的小折线/条(`3/7 → 5/7 → 7/7`),数据源 = `val:verdict.acResults`。
  - `human:asked` 未配对 → 「⏸ 等待人类决断」横幅(复用圆桌交互)。
- **留痕与服务分离**:transcript 永远写;viz 人在环时问一次要不要开(默认否),无人值守不开——serve 连上即回放历史,**cron 跑完后随时 `node serve.mjs <run-dir>` 事后看全程爬坡**。
- 孤儿防护同圆桌:自灭看门狗(`run:terminated`+末客户端断开宽限 / 无客户端兜底)+ viz.pid + 收官显式 kill。

## 10. 落地默认值

| 项 | 默认 |
|---|---|
| run-dir | `<cwd>/.loop/run-<时间戳-短随机>/` + `.gitignore` 一行 `/.loop/` |
| 无人值守评审团 | **双架构师**;cron prompt 可点名「圆桌」;人在环由用户开局选 |
| 卡死策略 | 迭代上限 5/goal;人在环问人;**无人值守中止后续 goal**,报告红字标 stuck,已通过成果保留 |
| 工作区 | 人在环主树;**无人值守 worktree+branch**(交付 = branch + 报告) |
| 验证者 | `access:"write"`(自建测试脚本,会话内自给自足),引擎≠生成者,每轮 fresh,全量重验;不改产品码由洁净树审计保证 |
| 生成者 | `write:true`,会话跨迭代复用,400k 关旧开新 |
| viz | 默认关;端口/自灭同圆桌(7345 回退;60s/10min 看门狗) |
| goal 依赖 | 默认按序依赖(不做依赖标记,YAGNI;真有独立 goal 用户拆成两次运行) |
| 代码评审 | **收官前整支 broad review 一次(必过,无人值守也不豁免)**;关键 goal 可选 `[review]` AC(主 agent 代执行、lazy) |
| 卡死菜单(人在环) | 三选:加轮(可顺带换生成者引擎)/ 改合同 / 放弃该 goal(默认随之收官,用户可口头覆盖继续) |

## 11. 失败模式

| 失败 | 兜底 |
|---|---|
| goal 卡死 | 见卡死策略 |
| 生成者/验证者会话挂 | `wait` 返回 failed/closed → doctor 换引擎重开;交接物=合同+缺陷清单+git log,无损 |
| AC 不可执行 | 合同闸前主 agent 逐条过「能不能照着跑」;验证者遇到无法执行的 AC → 标 BLOCKED 升级,不臆测 |
| 无人值守撞主树 | worktree+branch 根治 |
| 验证者留孤儿进程 | validator.md 进程卫生条款 + 主 agent 收官时 `cleanup` 兜底 |
| 验证者改了产品码(verdict 污染) | 每轮验证始于生成者 commit 的洁净树 → 验证后 `git status --porcelain` 有 tracked 改动即撤销 + `val:tainted` + fresh 重验——可检测、可回滚的硬审计 |
| 上下文腐化 | contextUsage≥400k 关旧开新(桥 skill 既有纪律) |
| wait 死等/abort | 两条致命纪律内联 |
| 生成者越界改文件 | 验证者 `git diff` 核对改动范围 vs goal 边界,越界记缺陷 |
| viz 孤儿 | 看门狗+pid+显式 kill(同圆桌) |

收官前主 agent 仍自己 `git diff` + 抽查关键 AC——**委托不盲信,无人值守也不例外**。

## 12. 实现交付物

| 交付物 | 说明 |
|---|---|
| `skills/agent-bridge-loop/SKILL.md` | 编排真理源(本设计的 skill 化;不是 changelog) |
| `skills/agent-bridge-loop/roles/generator.md` | 生成者角色(§7) |
| `skills/agent-bridge-loop/roles/validator.md` | 验证者角色(§7) |
| `skills/agent-bridge-loop/EVENTS.md` | 事件 schema 真理源(§8 完整化) |
| `skills/agent-bridge-loop/viz/serve.mjs` | 从圆桌拷贝(标注来源与版本) |
| `skills/agent-bridge-loop/viz/index.html` | 新前端(§9) |
| `skills/agent-bridge-loop/viz/sample/` | 样例 transcript + iterations(演示/前端 e2e fixture) |
| 分发 | junction 进 `~/.claude/skills` 与 `~/.codex/skills`(手动 link,同现行模式);README/INSTALLATION 补一行 |

**验收(实现这个 skill 本身的)**:
- 前端 e2e(jsdom,复用圆桌 fe-e2e 模式):live 流渲染、demo 抑制、爬坡曲线数据正确、seq 去重、XSS、半行缓冲、`/file`、reset。
- 结构检查:角色文件非空、SKILL.md 跨引用可解析、EVENTS 与前端消费字段一致。
- 一次小规模真跑(人在环 + 不要评审团 + 1 goal 2 AC)走通全链路。
- 双评审(异引擎,deepseek+codex)+ 修复到 APPROVE。

## 13. 已拍板决策记录

| 决策 | 结论 | 时间 |
|---|---|---|
| 无人值守默认评审团 | 双架构师(可点名圆桌覆盖) | 2026-07-06 用户 |
| 无人值守卡死策略 | 中止后续 goal | 2026-07-06 用户 |
| 无人值守工作区 | worktree + branch | 2026-07-06 用户 |
| 验证者权限 | `access:"write"`(自建测试脚本如 playwright,会话内自给自足不依赖桥工具);不改产品码靠洁净树审计 | 2026-07-06 用户 |
| 代码评审位置 | 收官闸(整支 broad review,必过)+ 可选合同 `[review]` AC(lazy) | 2026-07-06 用户 |
| 人在环卡死菜单 | 加轮(可换引擎)/ 改合同 / 放弃(默认收官,可覆盖) | 2026-07-06 用户 |
