# Loop 事件 schema(`transcript.jsonl`)

一次 loop 运行的**过程真理源**是 run-dir 下的 `transcript.jsonl`——一份 **append-only、单一 writer(主 agent)** 的事件流;**需求真理源**是同目录的 `contract.md`(验收合同)。可视化只 `tail` 前者;大文本(生成者汇报/验收 verdict/终稿)**旁挂**为文件,事件里只留引用(`genRef`/`verdictRef`/…)。

> **谁写**:只有主 agent(编排者)写 `transcript.jsonl`、`contract.md`、`iterations/`、`final.md`、`panel/gate-rulings.md`(合同闸裁决账本)——且 `iterations/` 里的原文是 `cp` 桥落好的 `textRef`(字节直传,不转写)。生成者只写产品代码(自己的工作树);验证者只写 `validation/`(自建验证资产);规划者只写 `planning/`(草案/建议,转正 = 主控 cp)。**都不写真理源。**
> **桥不替你写**:agent-bridge 只写 per-session 原始 `.log` / `bridge.log` / `exit-journal`;loop 事件必须主 agent 自己 append。

## 信封(每行都有)

| 字段 | 类型 | 含义 |
|---|---|---|
| `v` | number | schema 版本,当前 `1` |
| `seq` | number | 单调递增序号(从 0),writer 维护;可视化用它去重/排序 |
| `ts` | number | epoch 毫秒 |
| `event` | string | 事件类型(见下) |
| `runId` | string | 本次运行 id(= run-dir 名里的 `run-<id>`) |
| `payload` | object | 事件专属字段(见下表;goal/迭代归属放 payload 的 `goalId`/`n`) |

约定:`payload` 里凡是指向文件的字段(`contractRef`/`genRef`/`verdictRef`/`summaryRef`/`reviewRef`/`reportRef`/`draftRef`/`rulingsRef`)一律是**相对 run-dir 的相对路径**(如 `iterations/g1/i2-gen.md`),可视化 `/file?ref=` 只接受这种相对路径,拒绝绝对路径与 `..`。

## 事件类型

| `event` | 关键 `payload` 字段 | 表达什么 |
|---|---|---|
| `run:started` | `task`,`mode:{human:bool,panel:"architects"\|"roundtable"\|"none",workspace:"main"\|"worktree"}`,`iterCap`,`branch?` | 开跑:原始任务 + 三开关(无人值守 = `human:false`) |
| `viz:started` / `viz:stopped` | `url`,`pid`,`port` / `reason` | 可视化服务起/停(仅人在环同意开时) |
| `intake:asked` / `intake:answered` | `question` / `answer` | 需求访谈一问一答(苏格拉底式,人在环) |
| `panel:launched` / `panel:concluded` | `kind:"architects"\|"roundtable"`,`runDir` / `summaryRef` | 评审团子运行(面板有**自己的** run-dir/事件流,这里只记引用,不复述内容) |
| `planner:produced` | `kind:"contract"\|"amendment"\|"final"\|"advice"`,`draftRef`,`summary?` | 规划者产出草案/建议(`draftRef` 指向 `planning/` 下文件;是否转正走 `contract:*` / `run:final` 事件;主 agent append。viz 对未知事件安全忽略,渲染可后补) |
| `contract:drafted` | `contractRef`,`goals:[{id,title,acCount}]` | 合同草案落盘 |
| `contract:confirmed` | `by:"user"\|"panel"`,`changes?`,`rulingsRef?` | 合同闸通过。`by` 记录**闸的形态**(人在环=用户确认;无人值守=经面板批判)——**裁决人恒为主控**,逐条采纳/拒绝的账本在 `rulingsRef` → `panel/gate-rulings.md`(无人值守必填,防"主控裁决被记成面板裁决") |
| `contract:amended` | `changes`,`affectedGoals` | 中途改约;受影响的已通过 goal 标记复验 |
| `goal:started` | `goalId`,`title`,`acCount` | 开始一个 goal |
| `iter:started` | `goalId`,`n` | 该 goal 第 n 迭代(从 1) |
| `gen:produced` | `goalId`,`n`,`genRef`,`summary`,`commit?`,`filesChanged?` | 生成者交付(完整汇报在 `genRef`,字节直传;`summary`=主 agent 一句话) |
| `val:verdict` | `goalId`,`n`,`verdict:"pass"\|"fail"`,`acResults:[{acId,status:"pass"\|"fail"\|"skipped"\|"blocked",evidence?}]`,`defects?:[{acId?,desc}]`,`verdictRef` | 验收结果(**爬坡数据源**:acResults 逐条;完整 verdict 在 `verdictRef`)。`skipped` 用于 lazy 的 `[review]` AC(其它未全绿,本轮未执行) |
| `val:tainted` | `goalId`,`n`,`files:[…]` | 洁净树审计不过:验证者在产品树留下痕迹(改 tracked 文件**或遗留 untracked 残留**)→ 主 agent 撤销/清除 + 该次 verdict 作废 + fresh 重验(重验结果**沿用同一 n** 另发 `val:verdict`——迭代没有前进,只是重测) |
| `val:script-defect` | `goalId`,`n`,`acId`,`desc`,`evidence`,`discoveredBy:"generator"\|"controller"\|"validator"\|"reviewer"` | 仲裁认定**验证脚本(尺子)误判**:主 agent 亲手复跑该 AC 复现步骤后确认生成者产品是对的、是尺子错了 → 留痕裁决证据,交下轮 fresh 验证者修尺子(修改权仍只在验证者,见 SKILL.md §尺子的所有权)。纯争议轮不消耗生成者迭代配额,重验**沿用同一 n** 另发 `val:verdict`(同 `val:tainted`);混合回应轮并入正常下一迭代 |
| `goal:passed` | `goalId`,`iters` | goal 全绿(该 goal 最后一条 `val:verdict.verdict="pass"`) |
| `goal:stuck` | `goalId`,`reason:"iter-cap"\|"script-defect-loop"`,`policy:"halt"\|"user-extend"\|"user-amend"\|"user-abandon"`,`note?` | 卡死。`reason`=**为何卡**:`iter-cap`=达生成者迭代上限仍不过;`script-defect-loop`=同 goal 尺子仲裁 >2 次仍不收敛(尺子反复修不对)。`policy`=**采取的动作**:halt=无人值守中止后续;user-* = 人在环用户选(加轮/改合同/放弃) |
| `review:final` | `verdict:"approve"\|"needs-fixes"`,`reviewRef`,`round` | 收官闸:整支 broad review(NEEDS_FIXES → 打回生成者修,复评到 APPROVE 才 `run:final`;`round` 从 1 计) |
| `human:asked` | `questionId`,`question`,`options?`,`why` | 升级问人(仅人在环);可视化挂「⏸ 等待人类决断」 |
| `human:answered` | `questionId`,`answer` | 人已拍板;主 agent 将其作为约束注入后续 |
| `run:final` | `reportRef`,`goalsPassed`,`goalsTotal`,`branch?` | 收官(终稿在 `reportRef` → `final.md`;无人值守带交付 branch 名) |
| `run:terminated` | `reason:"done"\|"stuck"\|"user"\|"error"` | 运行结束(终态,可视化据此进入自灭倒计时) |

## 运行目录布局

```
<主树 cwd>/.loop/
  run-<id>/                    ← 一次运行的 run-dir(真理源都在这)
    transcript.jsonl           ← 本文件定义的事件流(真理源;SSE 只 tail 它)
    contract.md                ← 验收合同(需求真理源;格式见 SKILL.md §合同)
    iterations/g<K>/i<N>-gen.md      ← 生成者第 N 迭代完整汇报(主 agent cp 桥 textRef,字节直传)
    iterations/g<K>/i<N>-verdict.md  ← 验证者第 N 迭代完整 verdict(同上)
    panel/                     ← 面板产出引用(summaryRef 指向这;面板自己的 run-dir 在别处)+ 合同闸裁决账本 gate-rulings.md(主控写,rulingsRef 指向它)
    review/                    ← 收官 broad review 报告(reviewRef 指向这)
    validation/                ← 验证者自建验证资产归档处(见下)
    planning/                  ← 规划者自留地(合同/修约/终稿草案与建议;转正靠主控 cp)
    final.md                   ← 收官报告(run:final.reportRef 指向它)
    viz.pid                    ← 开了可视化时的服务 pid(兜底 kill)
```

**validation/ 的活动位置**:验证者工作时写在 `<其 cwd>/.loop/run-<id>/validation/`(自带 package.json,依赖不碰产品树;跨迭代留存复用)。人在环主树模式下这就是 run-dir 里的 `validation/`;无人值守 worktree 模式下它活在 worktree 里,**收官时主 agent 归档回主树 run-dir**。gitignore `/.loop/` 两处都覆盖(.gitignore 是 tracked 文件,worktree 同样生效)。

## 消费约定(给可视化)

- 连上 `/events` 先回放已有事件(晚开页面也见历史),再从当前字节偏移 `tail` 增量——见 `viz/serve.mjs`(拷自圆桌,语义相同)。前端按 `seq` 去重,SSE 断线自动重连的全量重放不会造成重复。
- 按 `goalId` 分段、按迭代排卡;**爬坡曲线**从 `val:verdict.acResults` 算(每迭代 pass 数/总数);`human:asked` 未见配对 `human:answered` 时挂等待横幅;`run:final` 渲染终稿面板。
- 大文本不进 JSONL:带 `*Ref` 的事件,用户点开时才 `/file?ref=` 拉全文。
- writer 崩溃可能留下**半行**:回放/tail 都必须**缓冲不完整末行到下一个 `\n`** 再解析,不 `JSON.parse` 半行。
