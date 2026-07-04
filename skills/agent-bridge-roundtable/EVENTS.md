# 圆桌事件 schema(`transcript.jsonl`)

一场圆桌的**唯一真理源**是运行目录下的 `transcript.jsonl`——一份 **append-only、单一 writer(主席)** 的事件流。
可视化只 `tail` 这一份;事后复盘也只读这一份。大产出(某席一轮的完整发言)**旁挂**到 `outputs/`,事件里只留引用。

> **谁写**:只有主席(主 agent)写这份文件。参会席全程 `write:false`,永不碰它。
> **桥不替你写**:agent-bridge 只写 per-session 原始 `.log` / `bridge.log` / `exit-journal`;圆桌事件必须主席自己 append。

## 信封(每行都有)

每行是一个 JSON 对象,公共字段:

| 字段 | 类型 | 含义 |
|---|---|---|
| `v` | number | schema 版本,当前 `1` |
| `seq` | number | 单调递增序号(从 0),writer 维护;可视化用它去重/排序 |
| `ts` | number | epoch 毫秒(与桥 `run.log.jsonl` 同形) |
| `event` | string | 事件类型(见下) |
| `rtId` | string | 本场圆桌 id(= run-dir 名里的 `rt-<id>`) |
| `round` | number | 所属轮次(`0`=盲发发散轮;`1..`=收敛轮;不属于任何轮的事件可省或用 `-1`) |
| `payload` | object | 事件专属字段(见下表) |

约定:`payload` 里凡是指向文件的字段(`outputRef`/`briefRef`/`decisionRef`)一律是**相对 run-dir 的相对路径**(如
`outputs/seat-a-r0.md`),可视化 `/file?ref=` 只接受这种相对路径,拒绝绝对路径与 `..`。

## 事件类型

| `event` | 关键 `payload` 字段 | 表达什么 |
|---|---|---|
| `run:started` | `question`,`seats:[{seat,agent,model,role}]`,`maxRounds`,`budget`,`vizEnabled` | 圆桌开场:议题、阵容、上界 |
| `viz:started` | `url`,`pid`,`port` | 可视化服务已起(仅当用户同意开) |
| `viz:stopped` | `reason:"final"\|"idle"\|"killed"` | 可视化服务退出 |
| `round:started` | `mode:"parallel"\|"serial"`,`plannedSpeakers:[seat]`,`rationale` | 一轮开始 + 主席为何这样排 |
| `turn:assigned` | `seat`,`briefRef`,`why` | 指派某席发言 + 依据(收敛轮附本轮简报路径) |
| `turn:produced` | `seat`,`agent`,`model`,`outputRef`,`charCount`,`summary` | 某席产出;完整原文在 `outputRef`,`summary` 是主席的一句话摘要 |
| `schedule:decision` | `decision:"next"\|"parallel"\|"probe"\|"converge"\|"escalate"\|"terminate"`,`nextSpeakers:[seat]`,`convergenceSignals`,`rationale` | **主席的调度决策 + 理由**(智力核心,务必写全 rationale) |
| `disagreement` | `topic`,`positions:[{label:"立场A",stance,fromSeat}]`,`kind:"by-merit"\|"needs-human"` | 一个分歧点:匿名立场 + 能否靠论证解决。`fromSeat` 仅进 JSONL(供审计),**简报对席匿名** |
| `human:asked` | `questionId`,`question`,`options`,`why` | 升级问人;可视化据此挂"⏸ 等待人类决断" |
| `human:answered` | `questionId`,`answer` | 人给了回答;主席将其作为约束注入下一轮 |
| `seat:skipped` | `seat`,`reason:"timeout"\|"failed"\|"closed"` | 某席掉线/持续超时被跳过,综合时标缺口 |
| `run:final` | `decisionRef`,`adopted`,`tradeoffs`,`openIssues` | 最终方案(全文在 `decisionRef` → `final.md`) |
| `run:terminated` | `reason:"converged"\|"maxRounds"\|"budget"\|"user"\|"error"` | 圆桌结束(终态,可视化据此进入自灭倒计时) |

## 运行目录布局

```
<cwd>/.roundtable/rt-<id>/
  transcript.jsonl          ← 本文件定义的事件流(真理源;SSE 只 tail 它)
  briefs/r<N>-brief.md       ← 主席每轮策展、匿名后的简报(参会席 read 这个,不读原始 transcript)
  outputs/seat-<x>-r<N>.md   ← 某席某轮完整发言(turn:produced.outputRef 指向它;主席在 close 席前把 textRef 落到这)
  final.md                   ← 最终方案全文(run:final.decisionRef 指向它)
  viz.pid                    ← 若开了可视化,记 SSE 服务器 pid(兜底 kill)
```

## 消费约定(给可视化)

- 连上 `/events` 先回放已有事件(晚开页面也见历史),再从当前字节偏移 `tail` 增量——见 `viz/serve.mjs`。回放覆盖服务器内存里保留的窗口(`MAX_EVENTS`,默认 2 万条,远超任何真实圆桌的事件量;仅作病态大文件的 OOM 护栏)。前端按 `seq` 去重,SSE 断线自动重连的全量重放不会造成重复。
- 按 `round` 分段、按 `seat` 分栏;`schedule:decision`/`disagreement` 高亮;`human:asked` 未见配对 `human:answered` 时挂等待横幅;`run:final` 渲染终稿。
- 大文本不进 JSONL:遇到带 `outputRef`/`decisionRef` 的事件,用户点开时才 `/file?ref=` 拉全文。
- writer 崩溃可能留下**半行**(未换行结尾):回放/tail 都必须**缓冲不完整末行到下一个 `\n`** 再解析,不 `JSON.parse` 半行。
