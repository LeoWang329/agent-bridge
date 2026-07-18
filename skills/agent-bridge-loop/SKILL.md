---
name: agent-bridge-loop
description: 用 agent-bridge 跑一个「合同驱动的自动交付循环」——把用户任务挖掘成带可执行验收标准的合同(可拉多架构师/圆桌评审团深挖),然后逐 goal 走「生成者实现 ↔ 独立验证者黑盒验收」循环直到全部通过,收官整支评审,全程事件留痕 + 可选爬坡可视化;支持完全无人值守(定时触发)。仅当用户明确要求「loop/自动交付/合同驱动闭环/无人值守完成任务」时使用;普通编码、单轮实现+评审(用 agent-bridge-dev)不要触发。依赖 agent-bridge skill 与其 MCP 工具。
---

# Agent Bridge · Loop(合同驱动的自动交付循环)

用户给一个任务 →(可选评审团)把需求挖透 → 产出**验收合同**(goals + 可执行 AC)→ 每个 goal 走
「**生成者干活 ↔ 验证者验收**」严格交替循环直到全绿 → 收官整支评审 → 报告。你(主 agent)是**编排者与唯一
事件 writer**;干活与验收由两个**异引擎**委托 agent 承担,合同/修约/终稿的**起草**默认委派规划者(§Planner)。
全程留痕,可选爬坡可视化,支持完全无人值守。

> **本 skill 只讲「怎么编排闭环」。桥机制/纪律见 agent-bridge skill;实现→评审工作流见 agent-bridge-dev;
> N 席审议见 agent-bridge-roundtable——都是子程序,不重造。**
> 设计依据(每条决定的为什么):`docs/DESIGN-agent-bridge-loop-skill-2026-07-06.md`(agent-bridge 仓)。

## 前置(务必先看)

1. **工具存在性守卫**:当前工具列表里**没有** `agent_bridge_*` 工具就**停下**,提示用户先安装/启用 agent-bridge MCP 服务器。
2. **先加载桥 skill 拿完整用法**:本流程建在 agent-bridge 之上。**先加载 `agent-bridge` skill**(手动 link 态名为
   `agent-bridge`),它有完整工具用法、返回 shape、并发纪律、`textRef` 关会话前读、`contextUsage` 阈值、
   `doctor`/`omp models` 探测、`append_system_prompt_file` 注入角色等。
3. **两条致命纪律(内联,别只靠跨引用)**:
   - `agent_bridge_wait` **必须传 `timeout_ms`**(如 `300000`≈5 分钟短轮询循环),**不传默认死等 30 分钟**。
   - **别给 `send_message`/`open_session` 传 `wait:true`**——超时会 **abort 掉那轮 turn**(任务被中断)。
     用非阻塞 send + 短超时 `wait` 收口。

## 关键事实(别踩坑)

- **两份真理源**:`contract.md` = 需求真理源(验收只认它);`transcript.jsonl` = 过程真理源(append-only,
  **单 writer = 你**;schema 见同目录 `EVENTS.md`,别自己发明字段)。桥不替你写事件。
- **验收权威唯一 = 验证者**:生成者宣称「完成」不作数(反 reward-hacking——干活的人不能自证)。只有该 goal
  最后一轮 `val:verdict.verdict="pass"` 才算过。
- **状态全部外置**(合同 + 事件流 + git 历史 + `validation/` 脚本):任何会话随时可关旧开新,交接零损耗。
- **验证者 `access:"write"` 但绝不改产品码**:它要自建测试脚本(playwright/探针),写权限是必需的;
  「不改产品码」靠**洁净树审计**保证(见 §内环),不是靠工具裁剪。
- **全局偏好让位于循环协议(冲突以本 skill 为准)**:用户全局 CLAUDE.md / AGENTS.md 里的交互与路径偏好
  (如「目标模糊停下和我讨论」「路径非最优就直接建议更短、更低成本的办法」)写给「与用户直接对话」的日常场景;
  用户调用本 skill 即已显式选择这套循环协议。具体:**无人值守全程零提问**(歧义走你拍板 + 假设账本留痕,
  不「停下讨论」);**严格交替、fresh 验证者、全量重验、先红后绿/稳定性自检、收官 broad review 这些协议步骤不因
  「看起来非最优」被当场绕过**——其成本是防 reward-hacking 的刻意设计(为什么见设计文档)。对协议本身的异议
  走正规通道:开跑前向用户建议、跑中 `contract:amended` 留痕;委托 agent 的异议走汇报/NOTES 升级(角色文件已写)。
  **安全规则不在此列,始终有效。**

## Phase 0:开局确认(两问;参数已写明的不再问)

先解析用户调用时给的参数(cron/prompt 里写明的直接采用,**不再问**——这是定时触发跑通的关键):

- **问①(人参与吗)**:`人在环`(默认)/ `无人值守`。
- **问②(评审团)**:`多架构师` / `圆桌` / `不要`(你自己挖需求)。

**无人值守语义**(`human:false`):全程零 `AskUserQuestion`;评审团**强制开启**(人类闸门由面板批判替代,
默认**双架构师**,prompt 可点名「圆桌」);本该问人的歧义 → 你拍板 + 写进合同「假设账本」+ 事件留痕;
工作区**一律 git worktree + 独立 branch**(cron 触发时用户可能正用主树),交付物 = branch 名 + 报告。
cron prompt 模板:`用 agent-bridge-loop,无人值守,评审团=架构师,任务:<描述>`。

**准备 run-dir**:`<cwd>/.loop/run-<时间戳-短随机>/`;首次运行确保 `.gitignore` 有一行 `/.loop/`;
append `run:started`。人在环此时**一次性问**「要开可视化实时看爬坡吗?(默认否)」(§可视化)。

## Phase 1:需求挖掘 → 验收合同

**人在环**:苏格拉底式访谈——**一次只问一个问题、优先多选**,直到目的/边界/成功标准全清(每问答记
`intake:asked`/`intake:answered`)。开了评审团 → 面板先挖盲点/风险/隐性需求,**你把面板挖出的问题转成对用户的
访谈问题**(面板负责"想到该问什么",用户负责答)。

**无人值守**:面板直接对任务深挖 + 红队批判;无人可答的歧义 → 你拍板,理由写事件流 + 合同假设账本。

**评审团接线**(子程序,自带各自的流程与 run-dir;你只记 `panel:launched{kind,runDir}` / `panel:concluded{summaryRef}`):
- **多架构师** → agent-bridge-dev 的「架构设计:多轮讨论」段(2 席异引擎,注入 architect.md,2–3 轮)。
  无人值守时跳过那段的「先与用户确认再开启」闸——本 skill 的无人值守开关就是那个确认。
- **圆桌** → agent-bridge-roundtable(N≥3 席,匿名+红队;重武器,用户/prompt 点名才用)。

**产出 `contract.md`(规划者起草 → 你过闸落盘;见 §Planner)**:

```markdown
# 验收合同 — <任务名>
模式: 人在环|无人值守 · 评审团: 双架构师|圆桌|无 · 生成: <ISO 时间>
## 原始需求(用户原话,逐字)
## 假设账本
- A1: <歧义> → 采取 <假设>(来源: 用户确认 / 面板推定+理由)
## Goal G1: <标题>
动机: <为什么>
验收标准(每条可被验证者独立执行验证):
- AC1 [test] <命令> 全绿
- AC2 [e2e]  <具体步骤/命令 + 预期>
- AC3 [log]  <跑什么后查哪个日志 + 预期>
- AC4 [review] 异引擎 reviewer 对 base..head 给 APPROVE   ← 关键 goal / 纯内部重构 goal 才写
边界: 不动 <Y>
## Goal G2: …(默认按序依赖)
## 全局约束        ← 涉 LLM 验证时可设「验证预算: <每迭代/全程判次或金额上限>」
```

- **AC 铁规**:每条都写「怎么验」——验证者能照着执行的才算;「代码质量好」这种不可执行的不收。
  合同闸前你逐条过一遍「能不能照着跑」。
- **AC 设计铁规(防"被考者出题")**:`[test]` 跑的是生成者自己写的测试(交付物的一部分,可能空转 / 断言缺失),
  只算**必要条件**。**凡 goal 有用户可观察行为,不得仅靠 `[test]` 类 AC 通过**——至少再配一条**验证者亲手执行的
  独立验证**从行为轴独立确认。「可观察行为」= 从产品**公开边界**调用后可见的任何东西:HTTP/API 返回、CLI 的
  stdout/exit code、写出的文件 / 持久化状态、日志、被下游当库消费的行为——**不限于 UI 或服务**;`[e2e]` 可以是
  CLI / API / 库消费者探针,`[log]` 查日志或落盘产物。只有**纯内部重构(无任何新的公开边界行为)**才可
  `[test]`+`[review]`。合同闸前你逐个 goal 检查这条,别把 CLI / 库 / 批处理类 goal 误判成"无可观察行为"。
- **AC 设计铁规(随机 / LLM 行为)**:断言 LLM / 概率性输出的 AC **不得用单发等值断言**(同输入两次跑结果就不同,
  单发必然 flaky、假 FAIL)——必须写成**配额阈值**:`[e2e] n 次采样里 ≥m 次满足 <性质>`(n/m 按业务容忍度定,
  采样**并发**跑省墙钟)。合同闸前:凡 goal 涉及模型 / 随机输出,检查其 AC 有没有阈值;没有就补——否则验证者验收时
  被迫替你拍一个阈值(= 替出题人改考卷),或用单发断言凭空 flaky。
- **AC 设计铁规(自然语言质量判断)**:「摘要要忠实」「回答要礼貌」这类要靠语言理解才能判的 AC,**不许一句话了事**——
  合同里必须拆成 **rubric**(逐条可判性质,如「无原文不存在的事实 / 关键数字一致 / 无遗漏主要结论」)+ 配额阈值
  (沿用上条 n≥m)。执行层由验证者落成**脚本化 LLM-judge**(见 validator.md §自然语言判断),**不是验证者通读一遍
  凭观感判**——观感不可复跑(仲裁裁无可裁)、fresh 会话间判准漂移、且是对随机 judge 的单发采样(违反上条)。
  rubric 缺失 = AC 缺陷,合同闸前补,别让验证者验收时替出题人发明标准。
- **验证的 LLM 成本纪律(预算)**:桥 skill 的「不考虑 token/成本」讲的是**编排取舍**(effort / 双评不为省钱缩水);
  验证期的 LLM 调用则是**乘法成本**(n 采样 × K 自检 × 迭代数 × 全量重验),不设防会烧穿——两者不矛盾,原则是
  **花法可优化,判准不可缩**。合同可在「全局约束」设**验证预算**(每迭代 / 全程判次或金额上限);AC 的 n/m/K 定值时
  须在预算内可完成。省钱只许省"浪费":early-stop(成功数 ≥m 即停、失败数 > n−m 即停,数学等价)、**先小后全两级
  采样**(中间迭代小样本 fail-fast 找缺陷,小样本默认 `⌈n/4⌉` 且 ≥3;**判 PASS 定论那轮必须跑满合同全量 n**;
  **配额类 AC 小样本里的散发失败 ≠ 违约**——判据是全量 n 中 ≥m,判红须确定性缺陷、或失败数按合同 n 已使 m 不可达,
  拿不准就升全量采样定论,别把合同允许的随机失败当红灯)、判次落盘复用不重打、judge 模型
  按判别难度选量级、稳定性自检用小样本夹具跑 K 次(不必全量套件跑 K 遍)。**预算耗尽 → 验证者标 BLOCKED/NOTES
  报你**(你加预算或 `contract:amended` 改 n/m),**绝不静默缩采样假装验完**。
- **AC 铁规(验证者的执行环境写进合同)**:合同须钉死①验证者的 cwd(worktree 模式给绝对路径);②**fixture 与临时
  输出一律落 `<cwd>/.loop/run-<id>/validation/fixtures/`,绝不落产品树**(否则污染工作树,还可能被你代 commit 时
  `git add` 扫进产品提交);③全局约束禁止任何带 `-x`/`-X` 的 `git clean` 与删除 `.loop/`(见失败模式表)。合同闸前逐条查这三样。
- **AC 执行者划分**:`[test]/[e2e]/[log]` 等可 shell 执行 → 验证者亲手跑(含自建脚本);`[review]` 需拉 bridge
  会话 → **你代执行**(验证者没有桥工具),且 **lazy**——该轮其它 AC 全绿才拉 reviewer,结果并入该轮
  `val:verdict.acResults`(未执行时标 `skipped`)。验收权威不多头:该轮 verdict 全绿才算过。
- **起草交给规划者(默认)**:访谈/面板材料齐后,open 规划者(`access:"write"`,注入 `<base>/roles/planner.md`)→
  send 指针(原始任务、transcript 里的访谈问答、`panel/` 产出、`planning/` 确切路径)+ **附合同模板与 AC 铁规原文**
  → 它在 `planning/contract-draft.md` 写草案、回复要点 + 待拍板清单(append `planner:produced`)→ 你按 AC 铁规
  逐条过 → cp 落盘为 `contract.md`(此时是**草案态**,append `contract:drafted`)→ **合同闸确认(`contract:confirmed`)
  之后才叫定稿**。中途改约同理:规划者出修订稿 `planning/amendment-<n>.md`(append `planner:produced`)→ 闸 →
  cp + `contract:amended`。需求极简时你可自己起草(但先想想是不是又在"顺手",§主控的手)。
- **合同闸**:append `contract:drafted` → 人在环交用户改/确认;无人值守由面板批判一轮、你逐条采纳/拒绝留痕
  → append `contract:confirmed{by,rulingsRef}`。中途改约 → 更新文件 + `contract:amended`,受影响的已通过 goal 标记复验;
  **无人值守的中途改约没有面板复审**(为一行 n/m 重拉面板不成比例)——兜底是**事后独立审计**:改约理由写进假设账本,
  收官 broad review 被明确要求审计每条 `contract:amended` 有无降标(见 Phase 3.1),防"把降标包装成修缺陷"自批自过。
  - **批判的采纳由谁落笔(dogfood 实测缺口,别含糊)**:**裁决是你的**(写 `panel/gate-rulings.md`:逐条采纳/拒绝
    + 理由,面板意见相左时你拍板;白名单「写真理源与裁决账本」);**改稿是规划者的**——把两份批判 + 裁决账本指给
    fresh 规划者,它**另存新版** `planning/contract-draft-v<n>.md`(不覆盖旧稿——事后审计要能重建面板批判的是哪一版;
    append `planner:produced{kind:"contract"}`,闸前修订仍是合同草案,`amendment` 留给定稿后的改约)→ 你按 AC 铁规
    复核 → `cp` 覆盖 `contract.md` → `contract:confirmed`。**别自己重写整份合同**(那是"顺手起草",§主控的手);
    只有**逐字级**的错字/编号修补才允许你直接改。
  - **合同闸抓不到的东西会反噬整轮**:实测中 v1 合同曾把某条 AC 的期望值算错,导致**正确实现必 FAIL、而错误实现
    恰好全绿**——闸门是唯一拦截点(验证者只会照合同判)。故:①面板必须被要求**亲手重算每条 AC 的期望值**;
    ②你对**判定性 AC** 至少亲手重算一条期望值(白名单「合同闸复算」——只读演算,此时无产品可跑,算的是合同自己的数)。

## Planner(规划者):重文书起草 + 参谋;工作台 = run-dir

主控上下文膨胀的大头是「读一大堆、想很久、写一份」的文书活。这类活剥给**规划者**,主控回归
「用户通道 + 桥工具 + 记账笔 + 闸门」。**编排/调度不可剥**(桥工具只在主控会话里,委托 agent 指挥不了别人),
星型拓扑不变。

- **它干三件事**:①验收合同草案(goal 拆分 + AC 全套铁规 + rubric/阈值/验证预算);②中途修约草案;
  ③收官 `final.md` 草案。另可受主控之邀做分析参谋(读 `iterations/` 归档,产出建议)。
- **地盘与权限**:`access:"write"`,**只写 `planning/`**(run-dir 下自留地,同 validation/ 先例——每角色一块地、
  每块地单一 writer);读全 run-dir + 产品树。产品树零改动由洁净树审计兜底(同验证者);run-dir 在 gitignore 下、
  洁净树审计照不到(**也没有 git 可恢复**)→ 用**快照审计**闭环,检测与恢复分开做:开 planner **前**,
  ①真理源(contract/transcript/iterations/final,都是小文本)**内容备份**到 run-dir 外(如你的会话临时目录);
  ②`validation/` 记**逐文件哈希清单**(`Get-FileHash` / `sha256sum`;`node_modules` 可排除)。收口**后**比对——
  `planning/` 以外有变化 → 草案作废 + fresh 重开;真理源**从备份原样恢复**;`validation/` 不重型备份,把漂移文件
  清单写进下轮验证者的 send,要求按「改过的脚本」重走先红后绿 + 稳定性自检(尺子重新自证)。见失败模式表。
- **信息流(星型不破,载荷走磁盘、消息只走指针)**:**读直通**——`iterations/` 归档你本来就逐轮 cp,
  规划者自己去读,零传话;**建议过主控**——它写 `planning/advice-*.md`,你读结论决定是否并入下一轮 send
  (注明来源);**修约过闸**——草案 → 合同闸 → 你 cp + `contract:amended`。为什么建议不直通生成者:
  **合同是生成者唯一需求来源**,直通 = 第二个老板 + 账本外指令,合同驱动就散了。
- **生命周期**:按需开关,不长驻——Phase 1 起草完可关;修约/收官时 fresh 重开(状态全外置,读 run-dir 即
  接手,零损耗)。引擎按能力挑(起草合同建议强档);**不受评审独立性硬约束**(它不裁决,裁判是你 + 闸)。
- **主控自身的上下文卫生(同一病根的另一半)**:状态全外置意味着**你自己也可被替换**——长 run 里临近腐化
  (症状:开始遗漏协议步骤、重复劳动)→ 收尾当前迭代,compact 或新开会话,从 run-dir 接手(合同 + transcript
  尾部 + git log + 当前 goal/迭代指针)。别硬撑着把编排跑降智。

## Phase 2:生成者/验证者循环(内环核心)

goals 按序串行。**严格交替、同一时刻只有一方活跃**(天然无并发写冲突)。引擎选择遵 dev §model 弹性策略,
**硬规则:验证者引擎 ≠ 生成者**(同引擎验自己的活不算第二意见);验证者跨迭代引擎保持同一个(判准一致)。

```
open 生成者(access:"write", cwd=工作区, append_system_prompt_file=<base>/roles/generator.md)
对每个 goal(append goal:started{goalId,title,acCount}——acCount 你从合同数出,前端显示与爬坡分母靠它):
  loop(n = 1..迭代上限,默认 5;append iter:started):
    1. send 生成者 ← 该 goal 合同全文 + 上一轮缺陷清单(首轮空)+ 基线 commit
       → wait(mode:"any", timeout_ms:300000) 循环收口
       → cp 其 textRef → iterations/g<K>/i<n>-gen.md;append gen:produced(你写一句话 summary)
       → **确保 commit(你的职责,不赖委托方自觉)**:生成者已 commit 最好;没 commit(mac/Linux 上 codex 的
         workspace-write 沙箱**保护 `.git/`** → commit 被拒、如实 BLOCKED;Windows 上 codex 走 danger-full-access、无此保护、
         可能自行 commit 成功)→ 无论哪种,**你都以 `git status` 为准兜底代 commit**——
         以 `git status --porcelain` 的**实际改动清单**为准 add(生成者自报的 filesChanged 只作交叉校验,
         两者差异大 → 先质询再提交,别把逃逸改动漏在基线外),`git commit -m "g<K>-i<n>: …(主控代提交)"`。
         洁净树基线是验收前置条件
       → **`validation/` 哈希比对**(send 前记逐文件清单、此刻比对;§Planner 快照审计同款机制):漂移 = 生成者
         碰了尺子(被考者改考卷)——记缺陷打回,漂移文件按「改过的脚本」交下轮验证者重走先红后绿 + 稳定性自检
    2. open 验证者(access:"write", cwd=同工作区, 引擎≠生成者, 注入 <base>/roles/validator.md)【每轮 fresh】
       send ← 该 goal 全文 AC 清单 + 基线 commit + validation/ 确切路径 + 「全量重验、逐条证据」
       → wait 收口 → 洁净树审计:`git status --porcelain` 有**任何输出**都算污染——tracked 改动撤销(git checkout),
         **untracked 新文件删除**(验证者的合法产物全在被 ignore 的 `validation/` 下;porcelain 里的 untracked =
         逃逸的 fixture / 临时输出,放行会在下一轮被你代 commit 扫进产品提交)
         → append val:tainted + close 该验证者 + fresh 重开重验
       → [review] AC 且其余全绿 → 你拉异引擎 reviewer 代执行,结果并入 acResults
       → cp verdict textRef → iterations/g<K>/i<n>-verdict.md;**解析 VERDICT(硬化,反歧义)**:只认
         **回复开头独立一行**的 `VERDICT: PASS|FAIL`,正文其它位置出现的一律忽略;并交叉校验逐条 AC——
         **有任何 fail/blocked 而首行是 PASS → 按 FAIL 处理**(逐条结果优先于总宣称);
         append val:verdict;close 验证者
    3. 全绿 → append goal:passed → 下一个 goal
       有红 → 把 DEFECTS 打回生成者(复用其会话)→ 下一迭代
       生成者「不修 + 理由」质疑某缺陷不成立(如疑为尺子 / 验证脚本误判)→ **主控亲手复跑该条 AC 的复现步骤裁决**:
         · 确成立 → 仍打回生成者修(正常走下一迭代)
         · 确不成立(验证脚本误判)→ append `val:script-defect`(goalId/acId/裁决证据/discoveredBy)+ 把该缺陷与证据
           写进打给下轮 fresh 验证者的 send,由**验证者修尺子**(不是生成者、也不是你亲手改脚本;见 §尺子的所有权与修改权)。
           **纯争议轮**(该轮全部缺陷均被裁定不成立)→ 不开生成者、产品 commit 不变、**不消耗生成者迭代配额**
           (生成者这轮没错),fresh 验证者用修好的尺子**沿用同一 n 全量重验同一 commit**;
           **混合回应**(部分 fixed、部分质疑被裁定不成立)→ 按正常迭代走(生成者已交新 commit),尺子缺陷与证据
           **并入同一次**打给下轮验证者的 send。**护栏**:同一 goal 内尺子仲裁累计 > 2 次仍不收敛(尺子反复修不对)→ 按
           `goal:stuck(reason:"script-defect-loop")` 升级(人在环三选 / 无人值守 halt),别无限空转
    4. 达上限仍不过 → append `goal:stuck(reason:"iter-cap")`:
       人在环 → AskUserQuestion 三选:加轮(可顺带换生成者引擎)/ 改合同(contract:amended)/
                放弃该 goal(默认随之收官,用户可明说让后续继续)
       无人值守 → policy:"halt":中止后续 goal,收官报告红字标 stuck,已通过成果保留
close 生成者
```

- **上下文卫生**:生成者会话跨迭代复用;`contextUsage.tokens ≥ 400k` → 关旧开新(交接物 = 合同 + 缺陷清单 +
  git log,状态全外置,无损)。验证者本就每轮 fresh。**主控自身同理**(§Planner 末条)。
- **cursor / kimi 生成者/验证者例外(非禁令,见桥 skill 的对应条目)**:①两者 `contextUsage` 都恒 `null`,上面 400k 阈值判据对它们失效——跨迭代复用的**生成者无法靠 token 阈值判轮换**,改按遗忘约束/质量下降/新任务等通用信号重开(桥 skill 既有);把 `null` 当**未知**、别当 0(验证者本就每轮 fresh、不受此影响);②角色注入都是**首轮软注入**,几十轮迭代经压缩可能漂,强角色纪律的 loop 优先真 system 提示后端(omp/codex/claude);③数据面:cursor 是**云端后端、chat 删不掉**,loop 多迭代 = 往 Cursor 云刷一堆含仓库内容的 chat;kimi 无云端 chat 存储、session 状态在本地,但**推理仍走 Moonshot 云端 API**——prompt 与读入内容照样出本机,数据敏感任务两者都慎用;④两者都仅 Windows。
- **验证者 fresh + 全量重验的为什么**:防「修 A 坏 B」回归 + 防「上轮验过了」惰性锚定;其状态 = 合同 +
  `validation/` 前轮脚本(外置复用,fresh 不返工)。
- 无人值守 worktree:建/收/兜底清理直接复用 roundtable §席位权限那套(基线=HEAD,未提交改动不进 worktree;
  生成者与验证者 `cwd` 都指向 worktree;结束保留 branch、`git worktree remove`)。
- **worktree 模式下必须给委托 agent 一份合同副本(dogfood 实测缺口)**:真理源 run-dir 在**主树**
  `<主树>/.loop/run-<id>/`,而生成者/验证者的 `cwd` 是 worktree——它们**读不到主树 run-dir**。建 worktree 后
  立刻 `mkdir -p <worktree>/.loop/run-<id>/validation/` 并 `cp` 主树 `contract.md` 进
  `<worktree>/.loop/run-<id>/contract.md`(worktree 的 `.gitignore` 同样含 `/.loop/`,不脏树)。
  **这是只读副本**:真理源仍在主树,合同 `amended` 后**重新 cp 覆盖**;副本不是验收判据通道——每轮 send 本就
  **内联该 goal 合同原文**(源=主树真理源),副本仅供委托 agent 会话中途重读,被篡改也影响不了判据;验证者的
  `validation/` 本就活在 worktree,收官时归档回主树 run-dir(见 Phase 3 §4)。

## 尺子的所有权与修改权(测试脚本归谁、脚本有 bug 谁修)

「测试脚本」在本 loop 里是**两类相反的东西**,所有权双向锁死——这不是新规则,是既有两条铁律的副产品:

| | 产品测试(unit / integration) | 验证资产(`validation/` 里的 e2e / 探针 / fixture) |
|---|---|---|
| 谁写 | **生成者**(TDD 是它的实现纪律) | **验证者**(自建,会话内自给自足) |
| 身份 | **交付物**(tracked,随代码进 repo) | **尺子的执行层**(gitignored,run 后归档,不进产品) |
| 对方能碰吗 | 验证者铁律「产品树零痕迹」→ **洁净树审计**兜底(porcelain 任何输出 → 撤销/清除 + `val:tainted`) | 生成者铁律「不碰 `.loop/`」+ **主控每迭代对 `validation/` 做哈希比对**(§内环 step 1;`.loop/` 被 gitignore,洁净树审计罩不住——被考者改考卷是最强作弊动机,不能只靠纪律;机制复用 §Planner 快照审计) |

**验证脚本(尺子执行层)有 bug 时**——发现权全开、修改权唯一:

- **发现 / 质疑:全员开放,只报告不动手**。生成者照缺陷复现跑不出来 → 「不修 + 理由」升级;验证者复用改进前轮
  脚本时自查、NOTES 质疑;主控解析 verdict 发现证据与结论对不上;收官 reviewer 白盒反推验收放水——都只**报告**。
- **修改:唯一 = 下轮 fresh 验证者**。`validation/` 无洁净树审计罩着,完整性只靠**单一 writer 所有权**:生成者改 =
  被考者改考卷(结构性禁止);主控亲手改 = 裁判下场兼当工具作者(下次这脚本出争议它裁自己的码),且 `validation/`
  一旦两个 writer 连"谁改坏的"都无法归因。故主控裁定尺子有误时,只 append `val:script-defect`(留痕裁决证据)+ 把缺陷
  附进下轮验证者的 send,由验证者改——**留痕在事件流、修改在验证者**,两权分离。
- **验证者血脉自己修不动(工具能力不足)→ 主控 `doctor` 换引擎重开验证者**:换人,不换规则(所有权不转移)。

## 主控的手:白名单(编排者不下场)

实测两次独立 run 出现同一种漂移:主控"顺手"写验证脚本 / 亲手跑基线 / 想直接修小缺陷——每次都有合理化
(「很机械」「省验证者上下文」「一行就能修」)。这不是个性问题,是 prose 编排的结构病(滑坡源头 = 下表这些
被批准的动手例外),所以用**穷举白名单**替代隐含边界。**主控亲手可做的全部**:

| 允许 | 边界(防滑坡) |
|---|---|
| 写真理源与裁决账本:transcript / contract / iterations 归档 / final / `panel/gate-rulings.md`(含用工具代笔,如事件 append 脚本) | 仅 run-dir;代笔工具放 `.loop/` 下、**只有主控一人用**、输出严格按 EVENTS.md 不发明字段 |
| 代 commit | **只 `git add/commit` 生成者的改动,绝不 Edit 任何产品文件**——代提交 ≠ 代修改 |
| 合同闸复算 | 闸阶段对判定性 AC 亲手重算期望值(≥1 条)——**只读演算**(此时无产品可跑,算的是合同自己的数);结论只进 gate-rulings,不预写任何 verdict |
| 仲裁复跑 | 仅生成者质疑时、仅争议那条 AC、**只读执行**;产出只进 `val:script-defect` 裁决,不产生 verdict、不顺手修 |
| 收官抽查 | 只读;发现问题**打回**,不自己修 |
| 代执行 `[review]` AC | 拉异引擎 reviewer 会话,不是自己评 |

**除此之外一律下放**:改产品码(含提示词等一切交付物)= 生成者;写 / 跑 / 改验证资产、执行验收 = 验证者;
重文书起草(合同 / 修约 / 终稿)默认 = 规划者(§Planner),你只闸与落盘。

**绊线(具名场景,发现自己正在做就停)**:
- 「这缺陷一行就能修,打回太浪费」→ **仍打回**。省下的几分钟用第三 writer 事故偿还:改动没人评审、
  生成者上下文漂移、缺陷归因断裂、transcript 记假账。
- 「验证者还没开,我先跑下测试看看状态」→ 可以跑,但结果**只准用于调度判断**,绝不能写成 `val:verdict`、
  绝不能替代验证者轮次。
- 「基线 / 夹具很机械,我代建省事」→ 那是验证资产(尺子部件),归验证者建;主控已建过的 → 移交验证者
  **重走先红后绿 + 稳定性自检**才可用于裁决,其产出的数据**喂进 verdict 前须验证者验证可复现**(抽样重跑比对)。
- 转发缺陷清单 = **cp 语义原样转发**,可补合同澄清,**不补修法**(与验证者「不替生成者修」同源)。

## Phase 3:收官

1. **整支 broad review 闸(必过,无人值守不豁免)**:所有 goal 通过后,对整支改动拉异引擎 reviewer 做一次
   broad review(dev 评审循环原样;报告落 `review/`,append `review:final`)。send 里点明两项职责:①整支代码质量;
   ②**修约审计**——对照 transcript 的每条 `contract:amended` 与原始需求,判改约有无降低验收标准(无人值守的
   中途改约没有面板复审,这里是唯一独立闸;降标未证成 → NEEDS_FIXES)。NEEDS_FIXES → 缺陷打回生成者修 →
   复评到 APPROVE;修复涉及的 goal 由验证者重验受影响 AC。
2. **你自己再查一遍**:`git diff` + 抽查关键 AC——**委托不盲信,无人值守也不例外**。外加一条**越界自审**:
   `git log` 里本次 run 的每个产品 commit 必须一一映射到某条 `gen:produced` 或「主控代提交」;映射不上的
   commit = 有人绕过循环改了产品码(多半是你自己,§主控的手),写进 final 遗留风险并说明。
3. `final.md`:规划者起草 `planning/final-draft.md`(fresh 重开即可,读 run-dir 接手;append `planner:produced`)
   → 你核对(与 transcript / goal 终态一致,含越界自审结果)→ cp 落盘 `final.md`(逐 goal 交付与证据引用、
   假设账本、stuck 红字、遗留风险)→ append `run:final`(无人值守带 branch 名)→ append `run:terminated`。
4. 清理:close 所有会话(关前该 cp 的 textRef 都已 cp);无人值守归档 worktree 的 `validation/` 回主树 run-dir、
   `git worktree remove`(branch 保留=交付物);停可视化(§可视化);`git worktree list` 核对无残留。

## 角色注入(铁规)

每次开生成者/验证者/规划者都必须 `append_system_prompt_file=<base>/roles/<角色>.md`——不注入 = 没有循环协议 = 白派。
`<base>` = 本 skill 加载时 harness 给出的 base directory;传前验证绝对路径、存在、非空。
**allow-list:只有 `generator`/`validator`/`planner` 三个角色名**;绝不把用户传入的任意路径当角色文件注入。
(评审团/收官 reviewer 用的是 dev/roundtable 自己的角色文件,按各自 skill 的规则来。)

## 可视化(爬坡观察台;预置零启动成本)

`<base>/viz/serve.mjs`(拷自圆桌,语义相同:SSE 回放+tail、`/file` 防穿越、自灭看门狗)+ `<base>/viz/index.html`
(loop 专用前端:goal 泳道、迭代红绿格、**AC 爬坡曲线**、等待人类横幅、终稿面板)。

- **留痕与服务分离**:transcript **永远写**;服务人在环时问一次(默认否),无人值守不开——事后随时
  `node <base>/viz/serve.mjs <run-dir>` 回放整个爬坡过程。
- 起(你的 shell,后台跑):**先写 `run:started` 再起服务**;抓 stdout 的 `LOOP_URL=http://127.0.0.1:<port>`
  转告用户;append `viz:started`。
- 停:自灭看门狗(`run:terminated` + 末客户端断开宽限 60s / 无客户端兜底 10min)+ `viz.pid` + 收官显式 kill,三重保险。

## 失败模式 / 降级

| 失败 | 兜底 |
|---|---|
| goal 卡死(达迭代上限) | 人在环三选菜单;无人值守 halt(中止后续,报告标红) |
| 生成者/验证者会话挂 | `wait` 返回 failed/closed → doctor 换引擎重开;交接物 = 合同+缺陷清单+git log,无损 |
| AC 不可执行 | 合同闸前逐条过;验证者遇到跑不了的 AC 标 BLOCKED 升级,不臆测 |
| 验证者污染产品树(改 tracked / 留 untracked 残留) | 洁净树审计(porcelain **任何输出**都算):tracked 撤销、untracked 删除 + `val:tainted` + fresh 重验(verdict 污染即作废) |
| 验证脚本误判(假 FAIL,冤枉生成者) | 生成者「不修+理由」→ 主控亲手复跑该 AC 复现步骤仲裁 → `val:script-defect` + 下轮 fresh 验证者修尺子(修改权唯一,见 §尺子的所有权);同 goal >2 次不收敛 → `goal:stuck(reason:"script-defect-loop")` |
| 尺子 flaky(好态偶发假红 → 假 FAIL) | 验证者「稳定性自检」:新建/改过且碰不确定性来源的脚本,同树连跑 K=3 结论须一致;抖了分诊——尺子自身抖(验证者稳定它)vs 被测系统随机(AC 缺配额阈值 → 报主控 amend);稳不住 → **该 AC 标 BLOCKED**,不假装验过(validator.md §稳定性自检) |
| 主控越界代工(顺手修 / 代建尺子 / 代验收) | §主控的手 白名单 + 绊线;收官越界自审(git log 产品 commit ↔ `gen:produced`/代提交一一映射,映射不上写 final 遗留风险);结构性根治 = 演化文档 L3(driver 握循环) |
| 验证预算耗尽(LLM 判次烧穿) | 验证者 BLOCKED/NOTES(写明实际采样 x/n + 置信度风险)报主控 → 加预算或 `contract:amended` 改 n/m;**绝不静默缩采样**(那是降验收标准) |
| 规划者越界(改产品树 / 改真理源 / 碰 `validation/`) | 产品树:洁净树审计(同验证者);run-dir(gitignore 下洁净树照不到、也无 git 可恢复):**快照审计,检测与恢复分开**——真理源开 planner 前内容备份(小文本)、漂移即原样恢复;`validation/` 记哈希清单、漂移文件交下轮验证者按「改过的脚本」重走先红后绿+稳定性自检;任一漂移 → 草案作废 + fresh 重开 |
| 规划者会话挂 / 超时 | fresh 重开(状态全外置,零损耗);连续 2 次失败 → **你自行起草(有痕降级:记 NOTES 说明原因——planner 不可用时的降级不算"顺手"越界)** |
| **带 `-x`/`-X` 的 `git clean` 抹掉整个 run-dir**(不可逆) | 禁的是**效果**(删掉 `.loop/`),不是某个拼写:小写 `-x` 删「忽略+未跟踪」;大写 `-X` **只删忽略文件**——读起来像无害的"清掉忽略的垃圾",实测恰好**只蒸发 run-dir、产品树纹丝不动**。合同 + transcript + 面板记录 + 尺子无 git 可恢复。设防:①**合同「全局约束」显式禁止**任何带 `-x`/`-X` 的 `git clean` 与任何删除 `.loop/` 的操作(起草时就写进去);②三份角色文件已内置禁令;③别在 AC 或 prompt 里写"回到干净工作区"这类**诱导措辞**;④评审团/reviewer 席位一律 `access:"read"`(codex 硬沙箱;omp/claude/cursor/kimi 软档,send 里别含清理类指令);⑤你的事件笔每次 append 都触碰 run-dir——**发现真理源丢失立即 halt 报告,别带着空账本继续跑**。真要清理用 `git clean -fd` |
| 委托 agent 在 worktree 里读不到合同 | 建 worktree 后 `cp` 主树 `contract.md` → `<worktree>/.loop/run-<id>/contract.md`(只读副本;`amended` 后重新 cp 覆盖)。见 §Phase 2 worktree 条 |
| 验证者留孤儿进程 | validator.md 进程卫生条款 + 收官 `node scripts/agent-bridge.mjs cleanup` 兜底 |
| 生成者越界改文件 | 验证者 `git diff` 核对改动范围 vs goal 边界,越界记缺陷;碰 `validation/`(尺子)由主控哈希比对抓(§内环 step 1) |
| codex 生成者无法 commit(仅 mac/Linux,沙箱保护 `.git/`) | 生成者如实 BLOCKED → 主控以 `git status` 为准兜底代 commit(全部细节见 §内环 step 1,不在此重复) |
| 上下文腐化 | `contextUsage ≥ 400k` 关旧开新(桥 skill 既有纪律);**cursor / kimi 恒 `null` → 当 unknown 不当 0**,复用的生成者改按遗忘/质量下降等通用信号重开 |
| wait 死等/abort | 两条致命纪律(§前置) |
| 无人值守撞主树 | worktree + branch 根治 |
| 孤儿 viz | 看门狗 + viz.pid + 显式 kill |

## 落地默认值

| 项 | 默认 |
|---|---|
| run-dir | `<cwd>/.loop/run-<时间戳-短随机>/` + `.gitignore` 一行 `/.loop/` |
| 迭代上限 | 5/goal(调用参数可改) |
| 无人值守评审团 | 双架构师(prompt 可点名圆桌);人在环用户开局选 |
| 卡死 | 人在环三选菜单;无人值守中止后续 goal |
| 工作区 | 人在环主树;无人值守 worktree+branch(交付 = branch + 报告) |
| 生成者 | `access:"write"`,会话跨迭代复用,400k 关旧开新(**cursor / kimi 例外**:无 token 读数→按遗忘/质量下降等信号重开) |
| 验证者 | `access:"write"`(自建测试脚本自给自足),引擎≠生成者,每轮 fresh,全量重验;产品码零改动靠洁净树审计 |
| 尺子稳定性自检 | 新建/改过且碰不确定性来源(网络/时序/并发/随机/LLM)的脚本:同树连跑 K=3 须结论一致;纯确定性脚本免跑 |
| LLM / 慢 IO 测试 | 多个独立调用**并发**跑(有界并发池 + 样本独立);随机输出的 AC 用配额阈值(≥m/n)不用单发断言 |
| 自然语言质量 AC | 合同给 rubric + 配额阈值;验证者落成脚本化 LLM-judge(冻结 prompt、钉死模型),观感只做 NOTES 交叉核验 |
| LLM 验证预算 | 合同「全局约束」可设(判次/金额);**花法可优化**(early-stop / 先小后全 / 判次复用 / judge 按难度选量级 / 自检小样本化),**判准不可缩**;耗尽 BLOCKED 报主控 |
| 规划者 | 默认启用(合同/修约/终稿起草);`access:"write"` **只写 `planning/`**(快照审计兜底),读全 run-dir + 产品树;按需开关、fresh 重开零损耗;连挂 2 次 → 主控自行起草(有痕降级);引擎按能力挑(起草建议强档),不受评审独立性硬约束 |
| 主控动手 | 白名单(写真理源与裁决账本 / 代 commit / 合同闸复算 / 仲裁复跑 / 收官抽查 / 代执行 `[review]`),其余一律下放;收官跑越界自审 |
| 代码评审 | 收官整支 broad review(必过)+ `[review]` AC(你代执行、lazy;关键 goal 可选、纯内部重构 goal 必配) |
| goal 依赖 | 默认按序(不做依赖标记,YAGNI;真独立就拆两次运行) |
| viz | 默认关;端口 7345 占用回退;自灭 60s/10min |

## 与 dev / roundtable 的边界

- **dev** = 单任务工作流原语(实现→评审→修;2-agent 架构讨论;并行调试)。**loop 的内环不是 dev 的评审循环**:
  reviewer 读代码(白盒),验证者跑系统(黑盒)——两个轴;loop 把 dev 当子程序(架构讨论、收官 broad review)。
- **roundtable** = N 席审议原语;loop 只在需求挖掘阶段按用户点名调它。
- 只要「实现一个已定义的任务 + 评审」→ 直接用 dev,别开 loop(YAGNI:loop 的增量 = 合同闸 + 黑盒验收循环 +
  无人值守 + 爬坡留痕;不需要这些就别付这个编排成本)。

## Integration / 跨引用

- **依赖 `agent-bridge` skill**(工具用法/纪律/contextUsage)与 `append_system_prompt_file`(注入角色)。
- **调用 `agent-bridge-dev`**(架构讨论、收官 broad review 的 reviewer 角色文件)与 **`agent-bridge-roundtable`**(圆桌评审团)。
- **本 skill 自带资产**:`roles/generator.md`、`roles/validator.md`、`roles/planner.md`、`EVENTS.md`(事件 schema 真理源)、
  `viz/serve.mjs` + `viz/index.html` + `viz/sample/`(演示与前端测试夹具)。
