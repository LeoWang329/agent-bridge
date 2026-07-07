---
name: agent-bridge-loop
description: 用 agent-bridge 跑一个「合同驱动的自动交付循环」——把用户任务挖掘成带可执行验收标准的合同(可拉多架构师/圆桌评审团深挖),然后逐 goal 走「生成者实现 ↔ 独立验证者黑盒验收」循环直到全部通过,收官整支评审,全程事件留痕 + 可选爬坡可视化;支持完全无人值守(定时触发)。仅当用户明确要求「loop/自动交付/合同驱动闭环/无人值守完成任务」时使用;普通编码、单轮实现+评审(用 agent-bridge-dev)不要触发。依赖 agent-bridge skill 与其 MCP 工具。
---

# Agent Bridge · Loop(合同驱动的自动交付循环)

用户给一个任务 →(可选评审团)把需求挖透 → 产出**验收合同**(goals + 可执行 AC)→ 每个 goal 走
「**生成者干活 ↔ 验证者验收**」严格交替循环直到全绿 → 收官整支评审 → 报告。你(主 agent)是**编排者与唯一
事件 writer**;干活与验收由两个**异引擎**委托 agent 承担。全程留痕,可选爬坡可视化,支持完全无人值守。

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

**产出 `contract.md`(写进 run-dir)**:

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
## 全局约束
```

- **AC 铁规**:每条都写「怎么验」——验证者能照着执行的才算;「代码质量好」这种不可执行的不收。
  合同闸前你逐条过一遍「能不能照着跑」。
- **AC 设计铁规(防"被考者出题")**:`[test]` 跑的是生成者自己写的测试(交付物的一部分,可能空转 / 断言缺失),
  只算**必要条件**。**凡 goal 有用户可观察行为,不得仅靠 `[test]` 类 AC 通过**——至少再配一条**验证者亲手执行的
  独立验证**从行为轴独立确认。「可观察行为」= 从产品**公开边界**调用后可见的任何东西:HTTP/API 返回、CLI 的
  stdout/exit code、写出的文件 / 持久化状态、日志、被下游当库消费的行为——**不限于 UI 或服务**;`[e2e]` 可以是
  CLI / API / 库消费者探针,`[log]` 查日志或落盘产物。只有**纯内部重构(无任何新的公开边界行为)**才可
  `[test]`+`[review]`。合同闸前你逐个 goal 检查这条,别把 CLI / 库 / 批处理类 goal 误判成"无可观察行为"。
- **AC 执行者划分**:`[test]/[e2e]/[log]` 等可 shell 执行 → 验证者亲手跑(含自建脚本);`[review]` 需拉 bridge
  会话 → **你代执行**(验证者没有桥工具),且 **lazy**——该轮其它 AC 全绿才拉 reviewer,结果并入该轮
  `val:verdict.acResults`(未执行时标 `skipped`)。验收权威不多头:该轮 verdict 全绿才算过。
- **合同闸**:append `contract:drafted` → 人在环交用户改/确认;无人值守由面板批判一轮、你逐条采纳/拒绝留痕
  → append `contract:confirmed{by}`。中途改约 → 更新文件 + `contract:amended`,受影响的已通过 goal 标记复验。

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
       → **确保 commit(你的职责,不赖委托方自觉)**:生成者已 commit 最好;没 commit(实测 codex 的
         workspace-write 沙箱**保护 `.git/`**,commit 必被拒 → 它会如实 BLOCKED)→ **你代 commit**——
         以 `git status --porcelain` 的**实际改动清单**为准 add(生成者自报的 filesChanged 只作交叉校验,
         两者差异大 → 先质询再提交,别把逃逸改动漏在基线外),`git commit -m "g<K>-i<n>: …(主控代提交)"`。
         洁净树基线是验收前置条件
    2. open 验证者(access:"write", cwd=同工作区, 引擎≠生成者, 注入 <base>/roles/validator.md)【每轮 fresh】
       send ← 该 goal 全文 AC 清单 + 基线 commit + validation/ 确切路径 + 「全量重验、逐条证据」
       → wait 收口 → 洁净树审计:`git status --porcelain` 有 tracked 改动
         → 撤销(git checkout)+ append val:tainted + close 该验证者 + fresh 重开重验
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
  git log,状态全外置,无损)。验证者本就每轮 fresh。
- **验证者 fresh + 全量重验的为什么**:防「修 A 坏 B」回归 + 防「上轮验过了」惰性锚定;其状态 = 合同 +
  `validation/` 前轮脚本(外置复用,fresh 不返工)。
- 无人值守 worktree:建/收/兜底清理直接复用 roundtable §席位权限那套(基线=HEAD,未提交改动不进 worktree;
  生成者与验证者 `cwd` 都指向 worktree;结束保留 branch、`git worktree remove`)。

## 尺子的所有权与修改权(测试脚本归谁、脚本有 bug 谁修)

「测试脚本」在本 loop 里是**两类相反的东西**,所有权双向锁死——这不是新规则,是既有两条铁律的副产品:

| | 产品测试(unit / integration) | 验证资产(`validation/` 里的 e2e / 探针 / fixture) |
|---|---|---|
| 谁写 | **生成者**(TDD 是它的实现纪律) | **验证者**(自建,会话内自给自足) |
| 身份 | **交付物**(tracked,随代码进 repo) | **尺子的执行层**(gitignored,run 后归档,不进产品) |
| 对方能碰吗 | 验证者铁律「不动任何 tracked 文件」→ 碰了有**洁净树审计**兜底(`git status` 抓到 → 撤销 + `val:tainted`) | 生成者铁律「不碰 `.loop/`」→ **纪律禁止,但无自动审计**(`.loop/` 被 gitignore,`git diff` 照不到);靠角色纪律,要硬化可在生成者轮前后对 `validation/` 做快照比对(YAGNI,暂不做) |

**验证脚本(尺子执行层)有 bug 时**——发现权全开、修改权唯一:

- **发现 / 质疑:全员开放,只报告不动手**。生成者照缺陷复现跑不出来 → 「不修 + 理由」升级;验证者复用改进前轮
  脚本时自查、NOTES 质疑;主控解析 verdict 发现证据与结论对不上;收官 reviewer 白盒反推验收放水——都只**报告**。
- **修改:唯一 = 下轮 fresh 验证者**。`validation/` 无洁净树审计罩着,完整性只靠**单一 writer 所有权**:生成者改 =
  被考者改考卷(结构性禁止);主控亲手改 = 裁判下场兼当工具作者(下次这脚本出争议它裁自己的码),且 `validation/`
  一旦两个 writer 连"谁改坏的"都无法归因。故主控裁定尺子有误时,只 append `val:script-defect`(留痕裁决证据)+ 把缺陷
  附进下轮验证者的 send,由验证者改——**留痕在事件流、修改在验证者**,两权分离。
- **验证者血脉自己修不动(工具能力不足)→ 主控 `doctor` 换引擎重开验证者**:换人,不换规则(所有权不转移)。

## Phase 3:收官

1. **整支 broad review 闸(必过,无人值守不豁免)**:所有 goal 通过后,对整支改动拉异引擎 reviewer 做一次
   broad review(dev 评审循环原样;报告落 `review/`,append `review:final`)。NEEDS_FIXES → 缺陷打回生成者修 →
   复评到 APPROVE;修复涉及的 goal 由验证者重验受影响 AC。
2. **你自己再查一遍**:`git diff` + 抽查关键 AC——**委托不盲信,无人值守也不例外**。
3. 写 `final.md`(逐 goal 交付与证据引用、假设账本、stuck 红字、遗留风险)→ append `run:final`(无人值守带
   branch 名)→ append `run:terminated`。
4. 清理:close 所有会话(关前该 cp 的 textRef 都已 cp);无人值守归档 worktree 的 `validation/` 回主树 run-dir、
   `git worktree remove`(branch 保留=交付物);停可视化(§可视化);`git worktree list` 核对无残留。

## 角色注入(铁规)

每次开生成者/验证者都必须 `append_system_prompt_file=<base>/roles/<角色>.md`——不注入 = 没有循环协议 = 白派。
`<base>` = 本 skill 加载时 harness 给出的 base directory;传前验证绝对路径、存在、非空。
**allow-list:只有 `generator`/`validator` 两个角色名**;绝不把用户传入的任意路径当角色文件注入。
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
| 验证者改了产品码 | 洁净树审计:撤销 + `val:tainted` + fresh 重验(verdict 污染即作废) |
| 验证脚本误判(假 FAIL,冤枉生成者) | 生成者「不修+理由」→ 主控亲手复跑该 AC 复现步骤仲裁 → `val:script-defect` + 下轮 fresh 验证者修尺子(修改权唯一,见 §尺子的所有权);同 goal >2 次不收敛 → `goal:stuck(reason:"script-defect-loop")` |
| 验证者留孤儿进程 | validator.md 进程卫生条款 + 收官 `node scripts/agent-bridge.mjs cleanup` 兜底 |
| 生成者越界改文件 | 验证者 `git diff` 核对改动范围 vs goal 边界,越界记缺陷 |
| codex 生成者无法 commit | codex 沙箱保护 `.git/`(实测,by design)→ 生成者 BLOCKED 汇报,**主控代 commit**;omp/claude 生成者可自行 commit |
| 上下文腐化 | `contextUsage ≥ 400k` 关旧开新(桥 skill 既有纪律) |
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
| 生成者 | `access:"write"`,会话跨迭代复用,400k 关旧开新 |
| 验证者 | `access:"write"`(自建测试脚本自给自足),引擎≠生成者,每轮 fresh,全量重验;产品码零改动靠洁净树审计 |
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
- **本 skill 自带资产**:`roles/generator.md`、`roles/validator.md`、`EVENTS.md`(事件 schema 真理源)、
  `viz/serve.mjs` + `viz/index.html` + `viz/sample/`(演示与前端测试夹具)。
