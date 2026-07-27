# agent-bridge-graph 可视化 —— 逐轮复审记录

**这不是设计文档。** 现行合同在 `docs/DESIGN-graph-viz-2026-07-26.md`（以及施工时会从它析出的 `EVENTS.md`）。
这里只回答一个问题：**每一条现行条款是被什么打出来的。**

⚠️ **本文件里的条款一律是历史快照，很多已经被后来的轮次推翻。要看现在怎么规定，看 DESIGN，不要引用这里。**

**背景**：v1 写于 2026-07-26。此后与 codex（`access:"read"`、xhigh、同一会话连续多轮）做对抗复审，**前 12 轮全部 CHANGES-REQUIRED、全部发现成立；第 13 轮 APPROVE**。

## 修订史（一行一版）

| 版本 | 判决 | 这一轮抓到的要害 |
|---|---|---|
| v2 | — | v1 写完当天 `access:"write"`（worktree）才合入（`d9effff`），补上写节点 |
| v3 | 3 B + 6 MA + 3 MI | 数条是 v2 自己写错的字段与矩阵 |
| v4 | 4 B + 5 MA + 4 MI | **抓的不是事实错误，是"合同没闭环"**——说了要什么，没说谁在什么时刻做、失败算谁的 |
| v5 | 4 B + 4 MA + 4 MI | 传递闭包与收尾时序（事件缺 `nodeSeq`、归档 ref 没重写、`inputRef` 与隐私口径互斥、final/EOF 竞态） |
| v6 | 3 B + 4 MA + 4 MI | **把我 v5 写反的收尾顺序纠回来**：先 close 会让排队节点在清场途中被唤醒开工 |
| v7 | 3 B + 3 MA + 3 MI | **我自己越了界**：把"排空发现节点失败"判成 run failed，等于让观测台去裁决业务成败 |
| v8 | 3 B + 2 MA + 2 MI | 判定"不加 manifest"这条分歧成立，但给了四个成立条件——v8 逐一兑现 |
| v9 | 4 B + 6 MA + 2 MI | **同一处矛盾第二次被抓**：`result` 判据在 §3.4 里写了两遍，上一轮只删掉一处 |
| v10 | 2 B + 4 MA + 2 MI | **第一次出现"可以删的机制"**：`archiveRef`、全局历史数组、close-error 第二路径 |
| v11 | 2 B + 3 MA + 3 MI | 又三样可删：`node:rejected` 重复的三份资产、逐事件 MUST 清单、单独的 flush 概念 |
| v12 | 2 B + 5 MA + 3 MI | **两个 BLOCKER 都在"上一轮刚修好的地方"**；又三样可删：`viz:started`、`pid`、wire `nodeRunId` |
| v13 | 3 B + 4 MA + 3 MI | **"改完一处"与"改干净一处"是两件事**；又四样可删：`viz:stopped`、`halt`、两个与信封重复的字段、这份复审记录本身 |
| v14 | 1 B + 3 MA + 2 MI | **最后一处会逼实现者去猜的合同**：viewer 自灭状态机。codex 判"修完它就可以动工" |
| v14 修补 | 3 B | **批量改动的回归伤**：删掉的字段还留在上限合同里、删掉的 `id` 留下必然假红的验收、`ownerEnded` 在"EOF + drain 失败"时不封闭（**viewer 永不退出**的资源泄漏死角） |
| **第 13 轮** | ✅ **APPROVE** | 三处闭合，不需要新增机制；给出施工顺序前三步 |

⚠️ **所有行号引用一律作废**——`node-core.mjs` 在 07-26 当天净增 776 行。全文按「函数名 + 邻近唯一语句」定位。

## 逐轮详情

### v2 → v3：codex 一轮，CHANGES-REQUIRED（3 BLOCKER + 6 MAJOR + 3 MINOR），逐条回源码核过全部成立

| 级别 | 发现 | 修在 |
|---|---|---|
| **BLOCKER** | 「一个 out-dir = 单进程」**不是现有不变式** | §3.1 合同 A |
| **BLOCKER** | `status × outcome` 矩阵有漏有错 | §5.1 |
| **BLOCKER** | `abandoned` = "结果永远拿不到了" 是事实错误 | §3.4 |
| MAJOR ×6 | `workspace` 无 `notes[]` / `filesChanged` 是对象数组 / `diffPath` 是绝对路径；`removed:false` ≠ outcome unknown；「排队节点磁盘上不存在」过强；缺"已发现"阶段；`attempts[]` 缺 `inputRef`；A 档叫"精确"过头 | §2A §2.1 §2.2 §2.4 §5.4 §6 |
| MINOR ×3 | outDir 不一定在仓库里；「每行 < 4KB」不成立；低估 serve 工作量 | §3.2 §7 |

### v3 → v4：codex 一轮，CHANGES-REQUIRED（4 BLOCKER + 5 MAJOR + 4 MINOR），逐条回源码核过全部成立

**这轮的性质不同**：v3 的事实错误基本清干净了（codex 独立重算确认 §5.1 矩阵、§5.3 蕴含、`removed` 解耦、并发闸各项都正确），抓的是**合同没闭环**——说了要什么，没说清谁在什么时刻做、失败了算谁的。

| 级别 | 发现 | 修在 |
|---|---|---|
| **BLOCKER** | 合同 A 落不了地：「绑定第一个见到的 outDir」没有时刻（桥在回调前就起）、`realpathSafe` 没用上、graphId 生成方式没定、writer 锁的释放与陈旧处理是空白 | §3.1 拆成四条可执行规则；**并去掉共享锁**（见下） |
| **BLOCKER** | 独立 transcript **没带来独立历史**：ref 仍指固定的 `nodes/<id>.*`，后波 `force` 一覆盖，旧页面内容就变了 | §3.1a graph 作用域不可变归档 |
| **BLOCKER** | 事件瘦身在"回执写失败"时断粮——而这**恰恰**是 §5.1 新增那格的成因之一 | §3.3 `receiptRef` 可空 + 两级兜底 |
| **BLOCKER** | 终态机有不可表示窗口：缺 `observed` 的 abandoned、缺"worktree 建到一半"、`saveScene` 强杀时根本没跑过、preflight/reuse/workspace 的 `UsageError` 没有终态、受控异常没有 `run:final`、生命管道不能等进程退出 | §3.3 `node:rejected` · §3.4 五档 + `run:final{result}` · §6 第 8/12 步 |
| MAJOR | 「单份 input.md 并用于派发」会**抹掉 system/user 边界** | §2.1 分通道冻结 |
| MAJOR | `unknown + delivered` 的成因写窄了（不止回执写失败）；`delivered` 允许 `filesChanged=[]` | §5.1 三种来源 · §5.3 |
| MAJOR | `removed:false` = "一定保留现场" 写强了——它是收尾快照，推不出"现在还在" | §5.4 |
| MAJOR | `attempts[]` 字段不可为空、`status` 无枚举、`n` 未定基、`<id>.md` 语义写错、**`RECEIPT_VERSION` 必须升且有迁移代价** | §2.2 |
| MAJOR | UI 把"排队中"写成"已经派了" | UIREQ §4.1 |
| MINOR ×4 | §0 还写固定 `transcript.jsonl`、「没有声明的拓扑」措辞；`node:started.n` 是假信息、"六档"说法混淆；`run:started.cwd` 语义不清 → `launcherCwd`；**`viz:stopped` 进 transcript 会破坏单 writer** | §0 §3.3 |

### v4 → v5：codex 一轮，CHANGES-REQUIRED（4 BLOCKER + 4 MAJOR + 4 MINOR），全部成立、全部已修

**这轮抓的是"合同闭环之后的传递闭包与时序"**——v4 把每件事都说了，但没说全链路。

| 级别 | 发现 | 修在 |
|---|---|---|
| **BLOCKER** | **事件没有 `nodeSeq`**：同 graph 内 `force` 顺序重跑同 id 合法（`active.delete` 在 `finally`），页面会把第二次的 rejected 记到第一次头上 | §3.1a `nodeRunId` 成为主键 |
| **BLOCKER** | **归档不是传递闭包**：复用返回 `{...prev}`，旧回执里的 ref 原样指向 canonical 或上一个 graph；`scene/` 没进归档；归档写失败没有政策 | §3.1a 三条闭包规则 + 两档失败政策 |
| **BLOCKER** | **`attempts[].inputRef` 与"viz 关不留明文"互斥**：viz 关时那个 ref 无处可指 | §2.2 改 `inputSha256` 恒有 + `inputRef` 可空 |
| **BLOCKER** | **收尾时序仍造假终态**：close 失败在 final 之后、`Promise.all` 中途失败时别的节点还没 settled、EOF 可能先于 viewer 的 500ms 轮询到达 | §3.4① 八步收尾 + viewer EOF drain |
| MAJOR | **只封闭了字段名，没封闭字节**：圆桌 serve 超 1 MiB **静默丢行**，丢的若是 settled/final 就是假 `abandoned` | §3.2 三条上限规则 |
| MAJOR | 不要共享锁成立，**但仍需进程内串行 writer**：异步 append 会让 seq=11 落在 seq=10 前面 | §3.2 |
| MAJOR | 验收里有假红（"拒绝前一个文件都没建"——transcript 早就建了）与假绿（只查顶层 `receiptRef`、rejected 只查"不是 unknown"、脏树只测放行方向） | §9 |
| MAJOR | **`/file` 的 root 不能是 outDir**：outDir 可能是仓库根，`?ref=.env` 就成了合法请求 | §3.2 收窄到 graph 归档 |
| MINOR ×4 | UI「运行中 = 已经派给 AI」自相矛盾；UI §4A 残留"原样留在磁盘上/现场还在"；文档里 v3/五种/六档等版本残留；**"尝试可能死在 open_session"不准确**（尝试循环在拿到 session 之后才开始） | UIREQ §4.1/§4A/§10 · §2.2 |

### v5 → v6：codex 一轮，CHANGES-REQUIRED（3 BLOCKER + 4 MAJOR + 4 MINOR），全部成立、全部已修

⚠️ **这轮最重要的一条，是把我上一轮自己写反的东西纠回来。**

| 级别 | 发现 | 修在 |
|---|---|---|
| **BLOCKER** | **收尾顺序反了**：v5 写"先 close 再排空"。而 `request()` 只查 `state.exited`、**不查 `state.closed`**，信号量又**没有取消语义**——于是 B 收场时释放名额、**C 在清场途中被唤醒，去建 worktree、发 `open_session`**，最后被 teardown 杀掉，留下 unknown + 残留工作树。而且先 close 还会**连现场一起弄丢**（saveScene / closeSession 都要桥活着） | §3.4① 改为「封 admission → 自然排空 → close」+ 异常优先级表 |
| **BLOCKER** | **`attempts[]` 缺 `artifactSha256`**：复用闸只验顶层产出与 diff，**没人验过 `<id>.a1.md`** → 被篡改的第一轮产出会被当作"不可变历史"归档 | §2.2 |
| **BLOCKER** | **`inputRef:null` 与 UI「两次原文都要能看」互斥**：复用一张 viz-off 的旧回执时，第二轮输入只剩指纹 | §2.2「可验证的重建」规则 + UIREQ §6.2 例外 |
| MAJOR | recording failure 没有统一终态：输入归档在 `observed` **之前**，而该节点可能直接 `rejected`——**没有 settled 可挂**；transcript writer 自身失败也没政策（抛上去会被通用 catch 变成业务 `unknown`，吞掉则制造假 `abandoned`） | §3.1a 三条硬性要求 + 生命管道的 `recording-failed` |
| MAJOR | 字节封闭只是"建议"不是合同，且漏了 `contextUsage`（后端原样对象）、每个 dep、`halt`/`counts`；截断没规定留头还是留尾 | §3.2 四条 MUST + 统一 `boundedSummary()`（**头尾都留**） |
| MAJOR | `attempts[].status` 有枚举、**没有映射**（timeout / 拒收 / 断管 / 复制失败各归哪档） | §2.2 判定表 |
| MAJOR | 验收缺：viz-off→viz-on 复用、篡改 attempt、收尾竞态、writer 坏掉、symlink 逃逸、`observed`/`queued` 两种中断；同 id 三条合同揉成了一条 | §9 |
| MINOR ×4 | §7 还写"随 run 消失"；归档树漏了 `scene/`；§3.1④ 还写旧的 `transcript-<graphId>.jsonl`；`inputSha256` 的编码没写 | 全文 |

**codex 对"是否加多了"的回答**：没有需要删掉的大机制；最短收敛路线就是「封 admission → 自然排空 → close」**不要**再加 gate 取消器与主动 quiesce，字节限制**只需一个通用 `boundedSummary()`**。v6 照此执行。

### v6 → v7：codex 一轮，CHANGES-REQUIRED（3 BLOCKER + 3 MAJOR + 3 MINOR），全部成立、全部已修

| 级别 | 发现 | 修在 |
|---|---|---|
| **BLOCKER** | **`allSettled` 没有 promise 所有权合同**：`bridge.runNode` 只是转发，`ACTIVE_NODES` 存的是防撞 key；而且 **`runNode(bridge, spec)` 是导出的公开 API**（`node-turn.mjs` 走的就是它），只包 `bridge.runNode` 会被绕过 | §3.4① 登记表 + 拆 `runNodeImpl()` |
| **BLOCKER** | **writer 坏掉后，「受控结束」与「随后被强杀」在 viewer 眼里一样** | §3.1a `recording-failed` + `owner-final` + 四档判定 |
| **BLOCKER** | ⚠️ **`run:final.result` 越了界**：v6 让"排空发现节点失败"判成 run failed——而节点失败一律正常 resolve、"怎么办"归调用方，`allSettled` 甚至看不出那个 `contract_error` 是不是回调有意接住的。**这是把只读观测台变成了隐式流程裁判** | §3.4① result 只看三样 |
| MAJOR | manifest 合同没定（内容/原子性/自身失败） | §3.1a **改为不加 manifest**，见下第 3 处分歧 |
| MAJOR | 事件表与 §3.2 总则两套合同：`node:rejected` 没列 `recordingError`、`node:observed` 的 ref 可空没写、`recordingError` 被错绑在 `receiptRef===null` 上、顶层 `artifactRef` 漏在可空清单外、`counts` 说是固定键集却没列键 | §3.3 |
| MAJOR | **`no-output` 判据与源码不符**：拿不到 `textRef` **不等于**它没输出；另发现**既有的首跑/复用不一致**——零字节产出首跑判 ok、复用却拒 | §2.2 判定表 + 零字节的产品修法 |
| MINOR ×3 | 一条验收假红（模板没变时第二轮**应该**能重建出 `inputRef`）；缺四组判别用例；"天然有界"只归因 `timeoutMs` 过强 | §9 · §3.4① |

### v7 → v8：codex 一轮，CHANGES-REQUIRED（3 BLOCKER + 2 MAJOR + 2 MINOR），全部成立、全部已修

| 级别 | 发现 | 修在 |
|---|---|---|
| **BLOCKER** | ⚠️ **同一份文档两个相反结论**：§3.4 主表已改成"节点失败不影响 run 结果"，可下面那张异常优先级表**还留着** v6 的"排空发现节点异常 → failed" | §3.4① 删掉并写明为什么 |
| **BLOCKER** | **无 manifest 方案有一条确定会断的路**：attempt 1 产出已归档 → receipt 归档失败 → `receiptRef:null` 而内联兜底又刻意不含 `attempts[]` → **页面发现不了那份确实存在的产出**。另有三个洞：`node:attempt` 的 input 没有自己的错误位、`archive-root` 失败时子资产会被读成"本来就没有"、SHA/byteCount 只在总则里说了没进 schema | §3.1a 资产判别联合 + `node:settled` 恒带有界 `attempts[]`（`reask ∈ {0,1}` ⇒ 最多两项） |
| **BLOCKER** | **控制通道没有可实现的合同**：怎么分帧、刷新后怎么补发、**`run:final` 自己写失败时在哪儿发 `owner-final`**（照 v7 的第 6 步会直接关管道 → 有序收场被误判成"owner 丢了"） | §3.1a 控制通道合同 + §3.4① 拆成十二步 |
| MAJOR | **20000 条回放窗口会静默残图**：晚开页面 / 刷新 / 断线太久都是正常场景，越窗后缺失的 `node:observed` **绝不能被读成"本来没有"**——那正好抽掉无 manifest 方案的前提 | §3.2 改为新连接从 transcript 完整回放 |
| MAJOR | `recordingError` 的"永远是 `[{what,code}]`"与 §3.2 的"超 2 KiB 换成 `boundedSummary()`"**互相冲突**（一换就分不出 unavailable 与 not-applicable） | 判别联合天然有界，冲突消失 |
| MINOR ×2 | "八步收尾"实际只编了七个号，且把四个顺序敏感动作挤成一步；UI 第 19 张图只要求了一种"记录损坏" | §3.4① · UIREQ §10 |

**codex 对"不加 manifest"的最终判断：站得住，不必退回 manifest**——但成立条件是四条（每个可点击资产都有不可截断、可完整回放的事件记录；receipt 失败时 attempt 仍可发现；四态在 schema 里封闭；控制状态与 transcript 刷新后都能重放）。**v8 把这四条逐一兑现了**，并被明确认可"没有触碰 SKILL 的不做流程引擎边界"。

### v8 → v9：codex 一轮，CHANGES-REQUIRED（4 BLOCKER + 6 MAJOR + 2 MINOR），全部成立、全部已修

| 级别 | 发现 | 修在 |
|---|---|---|
| **BLOCKER** | ⚠️ **`result` 的相反结论仍然同时存在**——§3.4 里有**两张**表，我上一轮只删了一张 | §3.4① 只留一处定义，其余指回去 |
| **BLOCKER** | **"不可截断"没兑现**：规则允许**任意**非终态事件超限整条丢，可 `node:observed`/`node:attempt`/`queued`/`started`/`workspace-*` 一旦没进 transcript，"完整回放"也回放不出来；终态骨架只保 `state` 时 `present` **点不开** | §3.2 只有 `progress` 可丢 + 骨架带齐 ref/sha/bytes |
| **BLOCKER** | **`scene` 是目录，套不进统一资产联合**：目录没有 sha/字节数，`/file` 明确拒绝目录，viewer 自己拼三个文件名 = 退回 404 探测 | §3.1a scene 改成容器 |
| **BLOCKER** | **回放→live 缺切换算法**：参考实现无缝是因为**同步**遍历内存数组后**同步**注册；改成读文件后，异步读必然三选一地丢事件/乱序/补旧值 | §3.1a 同步读到捕获偏移再注册 |
| MAJOR | **attempt 1 的产出在强杀窗口仍不可发现**（output 要等 `node:settled` 才公布，而那时根本没有 settled） | §3.1a 新增 `node:attempt-settled` |
| MAJOR | **`archive-root` 失败要求"每个资产 unavailable"写反了**——先天不适用的槽位会被谎报成"本该写却写失败"，验收还因此成了假红 | §3.1a + §9 |
| MAJOR | 事件层残留旧合同（`node:attempt` 说带输出 ref、ref 仍写成 `string\|null`、settled 仍讲 `receiptRef`） | §3.1a / §3.3 统一只讲 `AssetState` |
| MAJOR | 字节上限漏了 `model` / `effort` / 两处 `rejectedReason`，也没定 sha 格式与 ref 长度 | §3.2 |
| MAJOR | **UIREQ 没有消费资产四态的规则**——设计师完全可能把 `unavailable` 静默隐藏，把这一轮消灭的歧义原样造回来 | UIREQ §6.6 |
| MAJOR | **`writer.close()` 自身失败没闭合**（最容易被实现成 throw，于是 owner-final 与清理全跳过、还盖掉原始异常） | §3.4① 第 8 步 |
| MINOR ×2 | 施工表两处仍写"八步收尾"；`owner-final` 与删临时目录的先后语义没说清 | §6 / §9 · §3.4① 第 11 步 |

**验收里被它抓出的假绿假红**：`MAX_EVENTS+1` 那条允许"标个历史不完整也算过"（既然选了完整回放，就必须证明它完整）；archive-root 那条把先天 N/A 也要求成 unavailable。均已改，并补齐它列的六组缺失判别用例。

### v9 → v10：codex 一轮，CHANGES-REQUIRED（2 BLOCKER + 4 MAJOR + 2 MINOR），全部成立、全部已修

⚠️ **这轮我特意问的那条被证伪了**：v9 选了"同步整文件回放"，理由是"总量有界"——**而那个前提根本不存在**。

| 级别 | 发现 | 修在 |
|---|---|---|
| **BLOCKER** | **同步回放建立在不存在的前提上**：§3.2 只封了单字段、单行与**内存窗口**，**从没封过 transcript 的总行数/总字节**；`timeoutMs` 无上限、回调是任意 JS、`maxConcurrent` 只限并发不限累计，而 `MAX_EVENTS` **不截断磁盘文件**。源码自己就写着整文件 `readFileSync` 会冻事件循环 | §3.1a 改为异步流式 + 每客户端 replay buffer + SSE 背压 |
| **BLOCKER** | **"除 progress 外都保骨架"不可执行**：唯一那张骨架表只覆盖三种终态，于是 `node:observed` 只留 `{event,seq,nodeRunId}` 也算过——`spec`/`prompt`/`role` 就此永久消失。且终态骨架要求"每个 present 都有 ref/sha/bytes"与**没有 ref 的 `scene` 容器**直接打架 | §3.2 两条通用规则 + §3.3 逐事件 MUST 列 + 骨架表改成"叶子文件" |
| MAJOR | 事件层仍同时存在 `AssetState` 与旧 `*Ref`（`archiveRef`、`workspaceSummary.diffRef` 两个真理源） | **删掉 `archiveRef`**；`workspaceSummary` 去掉 `diffRef` |
| MAJOR | `node:attempt-settled` 生命周期没闭合：`node:attempt` 在开始时带了还不存在的 `rejectedReason`、"产出已归档"漏掉 `no-output`/`failed` 两种、`durationMs`/`charCount` 没标可空、§6 插桩表整个漏了它 | §3.1a 四态映射 + §3.3 + §6 第 10 步 |
| MAJOR | **UI 少一种状态**：`recording-failed` 发生在资产生产事件**之前**时，那个资产**连 AssetState 都没有**——三种说法都不对。另外 `code` 没有枚举，而 UI 要拿它显示原因 | §3.1a `code` 封闭枚举 + viewer 派生态；UIREQ §6.6 第六种 |
| MAJOR | **`writer.close()` 失败分支与 viewer 优先级互相抵消**：viewer 见到 `run:final` 就按 transcript 算，于是 close 损坏**永远显示不出来**，验收也成假绿 | §3.4① 第 8 步——"确认落盘"含 flush；之后关 fd 失败只是清理诊断 |
| MINOR ×2 | UI 有两个 `### 6.6`；"回放进行中追加"若用同进程 `setTimeout` 必然假绿（事件循环被占住），还缺慢客户端背压用例 | UIREQ §6.7 · §9 |

**这轮删掉的三样**（第一次出现"可以删"）：不可点击的 `archiveRef`、文件回放后不再承担正确性职责的**全局历史数组**、以及"final 已确认后又用 close error 宣布 recording failure"的第二套路径。

### v10 → v11：codex 一轮，CHANGES-REQUIRED（2 BLOCKER + 3 MAJOR + 3 MINOR），全部成立、全部已修

⚠️ **v10 那条"刚修好的回放协议"里，序号顺序被自己写反了**——上一轮把回放从同步整文件改成"流式 + 每客户端缓冲"，却把控制槽位排在了缓冲区刷出**之前**。

| 级别 | 发现 | 修在 |
|---|---|---|
| **BLOCKER** | **回放第 4 步顺序颠倒**：先补控制槽位、再刷缓冲区，会让缓冲里 `seq=11` 的 `node:settled` 排在 `recording-failed{atSeq:12}` / `owner-final` **之后**到达；已经按 owner-final 冻结的 reducer 会直接丢掉它 | §3.1a 改为**先刷缓冲、再补控制**，缓冲里 `seq ≥ atSeq` 的事件丢弃，控制状态带 `controlRevision` 供重放 |
| **BLOCKER** | **背压只写在回放路径上**：live 广播仍是裸 `res.write()`，一个慢客户端照样把服务端内存拖爆——上一轮只堵了一半的洞 | §3.1a：每客户端一条出站队列，live 与回放**共用同一个上限**，超限断开让它重连 |
| MAJOR | **逐事件的"MUST 保留"清单漏字段**：我写了两遍都漏（第一次漏 `execution`/`outcome`/`counts`/`inputSha256`/`rejectedReason`，第二次给 `run:final` 列了它根本没有的 `nodeRunId`/`id`）。**清单这个形式本身就是错的**——它是 schema 的第二个副本，永远会漂 | §3.2 换成一条不变式：**字段级有界化之后，schema 里有的字段一个都不能少**；只有标 `?` 的可以缺席。全部 `MUST 保留` 标注删除 |
| MAJOR | **`no-output` 映射成 `not-applicable` 是在否认一份存在的证据**：每次尝试一律写 `nodes/<id>.a<N>.md`，`copyBytes()` 对零字节照常成功、空文件也算得出 SHA——**磁盘上确实躺着一份审计原件** | §3.1a 改为 `present` + `byteCount: 0`；并写明"内容为空"（`status`）与"有没有被记下来"（`AssetState`）是两个维度，不能合并 |
| MAJOR | **attempt 条目的创建时机没锚死**：一进 while 就写 `attempts[]`，会凭空造出一次**从未发送**的假尝试（源码里预算耗尽时明说"还没来得及发第 N 轮"） | §3.3：预算检查通过之后、`send_message` 紧之前 |
| MINOR ×3 | `archiveRef` 删了但还有三处残留（归档树注释、第二处定义、§6 插桩表第 2 步）；"内存窗口只用于 live 广播"是全局历史数组删除前的遗留说法；验收里 `MAX_EVENTS + 1` 引用的常量已经不存在了 | §3.1a · §3.2 · §6 · §9（改成写死 20,001 条，并说明为什么不引用常量） |

**这轮删掉的三样：**

1. **`node:rejected` 重复的 `spec`/`prompt`/`role`**——插桩顺序保证 `node:observed` 一定在它之前，而 observed 不可丢、可完整回放；writer 若已经坏了，这条 rejected 本身也写不进去。重复三份没有新信息。
2. **逐事件 MUST 清单**（见上）——换成一条不变式。
3. **单独的 flush 概念**——v10 为了闭合 `writer.close()` 引入了"确认落盘含 flush"，于是又多出一个可失败的动作。**更短的合同是让 `append()` 只在实际写调用完成后才 resolve**：第 6 步 `await append(final)` 成功**就是**确认落盘，没有第二个动作可失败。（要抗断电得 `fsync`，R1–R6 没这个需求，不扩张。）

### v11 → v12：codex 一轮，CHANGES-REQUIRED（2 BLOCKER + 5 MAJOR + 3 MINOR），全部成立、全部已修

⚠️ **两个 BLOCKER 都落在 v11 刚动过的地方**——"这一处我刚修过"是本轮最不可靠的直觉。

| 级别 | 发现 | 修在 |
|---|---|---|
| **BLOCKER** | **控制消息仍会越过"已写盘、但 viewer 还没 tail 到"的正常事件**：v11 只排好了"已经进客户端缓冲的事件"与控制槽的顺序，可**控制走 IPC（立刻到）、事件靠 500ms 轮询（慢一拍）**，缓冲区**缓存不了 viewer 根本还没观察到的东西**。对 live 客户端**必现** | §3.1a：`recording-failed` 增加 **`lastGoodOffset`**，viewer 必须先把 transcript drain 到该偏移、把事件排进各客户端队列，**之后**才公开控制槽 |
| **BLOCKER** | **复用节点在回执归档失败时会丢掉输入指纹**：复用命中**不发任何 attempt 事件**（源码在幂等闸后直接 return），而 `node:settled.attempts[]` 里**没有 `inputSha256`**——于是"原运行 viz-off + 本次复用 + 归档回执也失败"这条路上，UIREQ 要求显示的「仅保留指纹」**连指纹都拿不出来** | `attempts[]` 每项**恒带 `inputSha256`** + 一条判别验收 |
| MAJOR | **"完整 schema 一个字段不少"这条不变式，缺一份完整的 schema**：它现在散在信封 / `AssetState` / 事件表 / `node:settled` 代码块 / 一条表外规则里；而且一批字段仍没有上限（`outDir`/`launcherCwd`/`cwd`/`path`/`branch`/`lastEvent`/`halt`） | §3.2：施工时先合成一份 **`EVENTS.md` 作为唯一规范**；补齐这批上限（路径类 512 B、`lastEvent` 白名单、`halt` 为 `string \| BoundedSummary`） |
| MAJOR | **"超限一律换 `boundedSummary`"会把结构字段变成对象**：`ref` 变成 `{name,code,head,…}`，页面拿它去拼链接——**当场违反那条不变式** | §3.2：只有显式声明为 `string \| BoundedSummary` 的**人类文本**字段才能降级；结构字段超限属于 recorder 失败，走 `recording-failed` |
| MAJOR | **`failed → unavailable` 与 v11 刚修的 `no-output` 是同一个错，只修了一半**：源码存在"`copyBytes` 已成功、随后 `readFileSync` 失败"的窗口——**盘上确实有那份产出**，却被写成"没保住" | §3.1a 映射表：`failed` 允许 `present` **或** `unavailable` |
| MAJOR | **`append()` 的"写调用完成"挡不住短写**：`writeSync` 与异步 `write` 都可能只写一部分；调一次就 resolve，会把**半行**判成"final 已确认"，而那半行在 viewer 眼里就是末尾半行 → **一次已确认的收场显示成被掐断** | §3.4① 第 6 步：四条合同（循环补齐 / 失败即 recorder 损坏 / resolve 点在底层回调 / **刻意不做 `fsync`**）+ 一条短写负对照 |
| MAJOR | **背压的"同一个上限"没有数字，回放自身的读失败也没有归宿**：按条数计等于没上限（单行 1 MiB）；`open`/`stat`/read 失败与非末尾坏行没有状态 | §3.1a：**每客户端 32 MiB，按 SSE 帧 UTF-8 字节计**；新增 viewer 本地态「历史读取失败」，**明令不得显示成"运行被掐断"**；补浏览器端 `seq` 去重（重连是全量回放） |
| MAJOR | **UI 术语表把 `id` 写成"唯一 id"**，与"同 graph 顺序重跑同 id 合法"直接冲突——设计师照它拿 `id` 当状态 key，第二次就会覆盖第一次 | UIREQ §2：`id` 是可重复的逻辑名，唯一键是 `nodeSeq` |
| MINOR ×3 | `code` 还留着"枚举化短码"的旧说法；UI 还留着"实际上它本该有"（对 `fingerprint-only` 不成立）；复用节点的 `durationMs` 是**原执行耗时**、`counts.reused` 是 `ok` 的子集，两处都没说；`archive-root` 验收没区分 graph 根与节点子目录（注错层必然假红） | §3.2 · UIREQ §6.6 · §3.3 + UIREQ §6.1 · §9 |

**这轮删掉的三样（外加一样）：**

1. **`viz:started` 事件**——页面能收到它就已经证明 viewer 起来了；`url`/`port` 是打印给人看的，不是这张图的历史。归到 `viz:stopped` 那一类：SSE-only。
2. **`pid`**（`run:started.pid` 与 `viz.pid` 文件）——文档自己禁止用 pid 判活、也不支持重启 viewer，**没有任何消费者**。留着只会让后来的人拿它去判活。
3. **wire 上的 `nodeRunId`**——`graphId` 在每条信封里、`nodeSeq` 在事件里，再传一个拼出来的字符串就是**同一身份的第三份副本**。改由客户端拼。
4. （外加）**attempt 1 的输入不另存一份**：源码首轮发的就是 `prompt.md` 的原字节、不做加工，所以 `attempts[0].input.ref` 直接指向它，两处 SHA 必然相等——**并写成验收断言**，将来源码真开始加工首轮输入，这条会当场变红。

### v12 → v13：codex 一轮，CHANGES-REQUIRED（3 BLOCKER + 4 MAJOR + 3 MINOR），全部成立、全部已修

⚠️ **这一轮的主题是「改完一处」不等于「改干净一处」**：三个 BLOCKER 里有两个，是我上一轮**已经改对了方向、但没扫干净**留下的——v12 把 `lastGoodOffset` 引进来却没定义它的提交点与唯一 reader；v12 把 UI 表格那一行改成"未观测到正常收尾"，正文却还写着"只对应进程被强杀"。

| 级别 | 发现 | 修在 |
|---|---|---|
| **BLOCKER** | **`lastGoodOffset` 不是封闭状态机**：只写了"成功 append 后记文件末尾"，没定义提交点（短写后物理 EOF 更大）、没规定唯一 tail owner（参考实现的 `poll()` 独占 `bytesRead`/`pendingBuf`/decoder，另起第二个 reader 会重复广播并拼坏多字节字符）、drain 自己失败时控制槽可能**永远不公开**（页面永远显示"运行中"，且不报错） | §3.1a：writer 两条（只在整行写完时推进 / 禁止失败时 `stat().size`）+ viewer 四条（唯一 reader / 提 `targetOffset` 而非新建 / 丢弃 > 偏移的预读字节 / drain 失败也照样公开控制槽）+ 四条验收 |
| **BLOCKER** | **重复 `id` 让拓扑边的端点无法确定**：删 wire `nodeRunId` 是对的，但 `deps:["x"]` 与 `nodes/x.md` 推断**都只指逻辑名**，页面上有两张 `id=x` 的卡时实现者只能猜 | §4：唯一实例→连；0 个或 ≥2 个→**不画实例边 + 标歧义**。⚠️ 不取"最近那次"——那是一次没有观测依据的推断 |
| **BLOCKER** | **UI 中断口径同节自相矛盾**：表格已改成"未观测到正常收尾"，正文仍写"只对应进程被强杀这一种情况" | UIREQ §4.1 / §8 标题与表格 / §10 第 14、19 图**全部统一**；强杀降为"最常见成因" |
| MAJOR | **`viz:overflow` 写成 SSE 注释帧，浏览器根本收不到**（注释以 `:` 开头，规范上就是保活用的；参考实现的 `: hb` 正是这个用法，前端只挂 `onmessage`）——承诺了一件页面收不到的事，配套验收也会假绿 | §3.1a 改为**具名事件** `event: viz:overflow` + 队列预留余量 + 一条"页面确实收到原因"的验收 |
| MAJOR | **归档树仍列通配的 `attempt-<n>.input.md`**，与"attempt 1 复用 `prompt.md`、且验收断言独立文件不存在"直接打架——施工图与验收必有一个失败 | §3.1a 树改成 `n ≥ 2 才有` |
| MAJOR | **UI 没有定义 `BoundedSummary` 怎么显示**：DESIGN 允许几个字段从字符串变成对象，UI 却还写"错误原文"——页面拿到对象是显示 `[object Object]`、还是只显示 head？ | UIREQ §6.4 新增**有界摘要组件**（头/尾/省略字节/总量/指纹）；文案改"错误详情"；**`tail` 退出降级清单**（它本来就是 240 字的字符串，天生有界） |
| MAJOR | **SKILL.md 仍写"不做可视化"**，而施工清单只说"增加可视化章"——照做会得到一份同时说"支持"和"不做"的 SKILL | §9 第 18 项：**明确要求删掉那一项**，同时保留"不做通用流程引擎/依赖解析/调度器" |
| MINOR ×3 | pid 删除有活跃残留（§3.1 仍说"viewer 的 pid/状态文件"）；UI 把端口写死 7345（占用时会回退随机端口）；施工清单又把"不丢事件"弱化成"只保终态" | §3.1（连没有消费者的 `viz.state.json` 一起删）· UIREQ §1 · §9 第 15 项引用 §3.2 那条不变式 |

**这轮删掉的四样：**

1. **`viz:stopped`**——v4 只把它移出 transcript、仍留作 SSE 事件。**但它没有收件人**：正常自灭发生在没有客户端的时候，异常停服浏览器有 `onerror`。「服务自灭倒计时」改由 SSE 首帧的截止时刻承载（倒计时本来就该早给，等到"我要停了"才发已经晚了）。
2. **`run:final.halt`**——UI 没有消费者，文档也明说它没有流程语义；留着就得为"回调返回任意 JS"背一整套序列化与摘要合同。**它是调用方那段 JS 的返回值，留在那里就够了。**
3. **`run:started.graphId` / `startedAt` / `node:queued.waitingSince`**——分别与信封的 `graphId` 与 `ts` 重复。理由与删 wire `nodeRunId` 一字不差。
4. **这份复审记录本身**（从 DESIGN 里搬到这个文件）——约 180 行考古已经开始**反向污染活跃条款**：这一轮的 MINOR 之一（"每节点个位数事件"）正是一句被后来的进度事件证伪、却还留在正文里当规模依据的旧话。

### v13 → v14：codex 一轮，CHANGES-REQUIRED（1 BLOCKER + 3 MAJOR + 2 MINOR），全部成立、全部已修

⚠️ **这轮的 BLOCKER 是我自己上一轮引进来的**：删掉 `viz:stopped` 是对的，但我给「自灭倒计时」找的替代（"SSE 首帧下发截止时刻"）**与自灭判据互斥**——客户端一接入就取消计时，所以有人在看的时候**根本不存在一个真实的截止时刻可发**。正确的处置是**把倒计时这个需求删掉**。

| 级别 | 发现 | 修在 |
|---|---|---|
| **BLOCKER** | **自灭同时被定义成两套**（"无客户端才计时" vs "首帧下发绝对截止时刻"），且施工表只把 `run:final` 当触发点——**漏了四档收场里的三档**（writer 坏后受控收尾 / 坏后强杀 / 普通强杀都没有 `run:final`）。参考实现还有一个更深的坑：**"无客户端 10 分钟退出"不要求 run 已结束**，于是两小时的运行只要前十分钟没人看，viewer 就在半途消失，而 v1 不支持重开旧 run——"事后复盘"当场作废 | §3.3 新增**唯一合同**：`ownerEnded` 谓词（三条来源）+ 四条政策 + 删掉那个 idle 兜底 + 写明"同步取消"与两种时序 + 四条验收；UIREQ §8 倒计时改静态说明 |
| MAJOR | **复审史没搬干净**：DESIGN §0 顶部仍是逐版主线，且**含已作废条款**（"逐事件 MUST 清单"已删、"八步收尾"现在是十二步、"可空 `receiptRef`"已被 `AssetState` 取代） | §0 那段整块删除；**行内 `（vN 修）` 版本标注全文清除**——判据是 codex 给的那句：**版本标注不该留，支撑现行规则的技术理由该留** |
| MAJOR | **验收仍要求一个已经删掉的 viewer 状态文件**——正确实现没有这个文件，测试作者只能二选一：把正确实现判红，或者把刚删的文件加回来 | §9 脏树用例改成只验 transcript |
| MAJOR | **"未观测到正常收尾"仍有一处说反**（UIREQ §4.2 把"没观测到"写成了事实结论），且两条验收**已经假绿**：它们断言"不显示成『运行被掐断』"，可那句文案已经不存在了——**错误地显示成新文案照样能过** | UIREQ §4.2 措辞；两条验收改成断言**语义态**（`historyReadFailure` / `recordingIntegrity=damaged`），**断言状态，不断言废弃文本** |
| MINOR ×2 | §3.2 又列了一份不完整的"终态事件"清单（漏了 `node:attempt-settled`，而它正是强杀窗口里保住 attempt 1 的关键），与"只有 progress 可丢"这条真理源重复；`run:started` 的 `launcherCwd` / `label` **没有任何消费者** | 整项删掉 / 两个字段删掉 |

**这轮删掉的四样：**

1. **参考实现那个"无客户端 10 分钟退出"的兜底**——它会打断长运行（见上）。防孤儿由父进程生命管道负责。
2. **`run:started.launcherCwd` 与 `label`**——UIREQ、R1–R6、`withBridge` API 三边都没有消费者；节点 `cwd` 早被 `normalizeSpec()` 转成绝对路径，不需要谁去解析相对路径。
3. **非 `node:observed` 事件里的 `id`**——`nodeSeq` 已是实例键，而 `observed` 保证先发、不可丢、可完整回放。与删 `nodeRunId`/`graphId`/`startedAt`/`waitingSince` 同一条理由。
4. **全文的行内版本标注**——留反例，删版本叙事。

**codex 的收尾判断**：「离可施工只差一件架构决定：把自灭状态机定成唯一合同。修完它、并清掉三处活跃残留后，可以动工，不需要再做一轮架构扩张。」

### 第 13 轮：✅ APPROVE

三处回归伤闭合：①§3.2 字段清单已与事件 schema 一致；②`node:settled` 验收不再错误要求 `id`；③drain 成功与"失败已处置"都算"已结束"，第五条验收能判别那个资源泄漏死角。

**BLOCKER-3 不需要新增机制**：drain 的 resolve/reject 汇入同一条收尾路径，reject 先置 `historyReadFailure`，随后重算 `ownerEnded` 并起 grace。

**施工顺序前三步**（已抄进 DESIGN §9）：①唯一规范 `EVENTS.md` + 校验 fixture；②记录基础层（graph 作用域 / 顺序 writer / 归档闭包 / 控制通道 + 故障注入测试）；③接进 `node-core.mjs`（`nodeSeq` / 插桩顺序 / promise 登记与 admission 封闭 / 收尾协议）。

### 这 13 轮里最贵的几条教训

1. **"这一处我刚修过"是最不可靠的直觉**——v12 的两个 BLOCKER 都落在 v11 刚动过的地方；v14 的三个阻塞项全是同一轮批量改动的回归伤。
2. **同一处矛盾会被抓第二次**：`result` 判据写了两遍我只删一处（v9）；"未观测到正常收尾"改了表格没改正文（v13）。**改一处 ≠ 改干净一处，必须全文扫同族。**
3. **清单永远会漂**：逐事件 MUST 清单两轮各漏一批字段，最后换成一条不变式才闭合。**能用不变式的地方别用清单。**
4. **删比加难，但收益更大**：最后五轮每轮都能删掉三四样机制，且没有一样是"少做了功能"——全是同一事实的第二份副本、或者为不存在的场景准备的机制。
5. **验收比条款更容易假绿**：断言"不出现某句旧文案"在文案改名后必然通过；断言"某个语义态"才判别得了。

### v4 与 codex 建议的两处分歧（**采纳更短的路，理由写明；第三、四轮 codex 均明确认可这两条**）

1. **不加共享 `viz.writer.lock`**（codex 建议加，配 ownerToken / 陈旧锁 fail-closed / viewer 代删）。
   理由见 §3.1④：每个 graph 写自己那份随机命名的 transcript，**没有任何代码路径会 append 一份已存在的 transcript**——单 writer 是结构上成立的，不是靠互斥换来的。加锁只会引入陈旧锁这个真实的运维债（今天现场刚留下过一个陈旧的节点锁），而它**什么都不保护**。
   → **第三轮 codex 认可**：「我找不到需要跨进程 writer 锁保护的共享文件」。但它同时指出**进程内仍需串行写队列**——那是另一件事（顺序，不是互斥），已按其建议写进 §3.2。
2. **不做 owner 文件 fallback**（codex 要求"至少对 pid 存活但可能复用保持 unknown"）。
   理由见 §3.4③：viewer 只由 `withBridge` 拉起，**v1 根本没有单独启动 viewer 的入口**，所以"viewer 重启后判活"这个场景不存在。为不存在的场景设计一个判不准的算法，不如把限制写清楚。
   → **第三轮 codex 认可**：「在"viewer 只能随 withBridge 启动"的 v1 边界内成立」，只要求补 EOF drain（已在 §3.4①）。
3. **不加归档 manifest**（codex 建议加：版本 / `complete` / 每个资产四态 / 先落资产再原子换 manifest / manifest 自身失败另有语义）。
   理由见 §3.1a：**事件流已经能表达那四种状态**，而且是同一份真理源；加一份 manifest 就得再回答"manifest 自己写失败怎么办"——**用一个新文件去解释旧文件的缺失，只是把同一个问题挪了一层**。代价是资产四态必须在 schema 里**封闭成判别联合**（不是"可空字符串 + 另一个字段点名"那种隐式判据），**这一条已经写进去了**。

### 我自己核出、两轮 codex 都未提的三条

- 复用命中的节点在闸之前 `return`，`node:settled{reused}` 不该有 `node:queued` 前导；`startClock()` 在 acquire 之后，排队**不消耗超时预算**，页面不能暗示倒计时（§2.4）
- **viz 写出的任何文件都不能落在 `outDir/nodes` 之外**：脏树闸排除的是「未跟踪 **且** 前缀为 `outDir/nodes`」，不是整个 outDir。落在外面，会在 **outDir 位于仓库内且未被 gitignore** 时让我们自己写的文件把主树弄脏、再被自己的脏树闸拦下。⚠️ 本仓 `.graph/` 恰好被忽略，**这个 bug 在本仓复现不出来，只在别人的仓库上炸**（§3.1a）

  ⚠️ **这条我第一遍只用在了归档上，没用在 transcript 上——codex 第三轮抓出来的。** transcript 那条**更早爆**：它在用户回调之前就创建，第一个 write 节点就被拦。教训是：不变式一旦立了，就得扫一遍**所有**写盘点，而不是只改当时正在写的那一处。
- 冻结输入若直接落 `nodes/`，会让**viz 关着也留一份全量 prompt 明文**，把 §7 的隐私口径悄悄废掉 → 冻结走 run 临时目录，持久化严格挂钩 viz 开关（§2.1）


---

## UI 需求文档的逐版改动（v12 及更早）

> ⚠️ 下面这几段是从 UIREQ 顶部搬来的原文，里面的版本号指的是**文档修订号**。

> **某一版改了什么**：第十一轮技术复审。①**「运行被中途掐断」整个改名为「未观测到正常收尾」**（§4.1 状态表、§8 标题与表格、§10 第 14/19 张图）——早先的稿子只改了表格里一行，正文却还写着"只对应进程被强杀"，**同一处口径出现两个相反结论**。定义是"我们没看到它正常收尾"，强杀只是最常见的**成因**。②新增**「有界摘要」组件**（§6.4）：长文本超限时不是一段完整原文，而是"头 + 尾 + 省略了多少 + 总量 + 指纹"，**结尾必须显示**（根因常在最后一行），绝不能出现 `[object Object]` 或"只给开头且不说省略过"。③端口 7345 不再写死（被占会自动换）。
> **某一版改了什么**：第十轮技术复审。①**术语表订正**：环节的 `id` **不是唯一的**（同一次运行里允许重跑同一个环节），页面唯一键另有其物——照旧理解会让第二次覆盖第一次。②§8 两行订正：「断线」不再等于"服务停了"（数据太快时服务端会**主动断开让页面重连**）；「历史回放不完整」不再是"打开得晚/刷新过"（那些现在一定完整），只在**读历史真出错**时出现，而且**不许显示成"运行被掐断"**。③「运行已中断」不能写死成"进程被强杀"——两条报信通道同时坏掉时，它其实可能有序收了场。④复用环节的"执行耗时"要标成「**原执行耗时**」。
> **某一版改了什么**：第九轮技术复审。§6.6 **订正了"拿不到"这一档的含义**——早先的稿子把它定义成"本该有但记录时失败了"，可它的原因里有一条（当初没开可视化、只留了指纹）**根本不是故障**，那样写等于给一次正确运行扣故障帽子。现在它只表示「**页面想给你打开，但打不开**」，是不是故障由原因文案分辨。同时说清**原因码是开放的、以后会加**，页面遇到没见过的必须原样显示、不许归到某条已知原因上。
> **早先的稿子及更早的逐版改动** 见 `docs/REVIEW-LOG-graph-viz-2026-07-26.md`（早先的稿子起搬走：设计师只需要知道最近几版改了什么，更早的属于考古）。

### 更早（v10 及以前）

> **v10 改了什么**：第八轮技术复审。§6.6 补第六种状态——**记录断了，所以这一项连状态都不知道**（它要盖过其余五种的推断），并把"没记下来"的原因收敛成有限几种（含一种**根本不是出错**的：当初没开可视化、只留了指纹）。
> **v9 改了什么**：第七轮技术复审。新增 §6.6——**页面上每一个"可点开的东西"都有四种状态**（有 / 不适用 / 没记下来 / 等待中），四种必须长得不一样；尤其"**没记下来**"绝不能被静默隐藏成"不适用"。另加第五种情况：显示为「有」但点开已不在 → 说"记录时它在，现在取不到了"。"现场"是目录，三样东西要各自列状态。
> **v8 改了什么**：第六轮技术复审。§8 的「观测记录损坏」拆成**两个变体**（"已结束但记录损坏" / "记录损坏且不知后续"），§10 第 19 张图要求两者都出；并新增一条非常态：**历史回放不完整**——晚开页面或刷新过时，**不能把"没回放到"显示成"本来就没有"**。损坏态里的汇总计数必须标成部分计数。
> **v7 改了什么**：第五轮技术复审。§8 新增第三种收场——**观测记录损坏**（运行往往照常跑完了，只是没人记下来）。最关键的一条：记录坏掉之后，**绝不能把那些没有结局记录的环节逐个标成"被掐断"**——那会让用户去排查十几个根本没出问题的环节。§10 相应新增一张图。
> **v6 改了什么**：第四轮技术复审。§6.2 补一个必须设计的例外——**复用来的环节，如果当初那次运行没开可视化，第二次的输入原文在磁盘上不存在**，只剩指纹；页面要如实说，绝不能"还原"一份看起来对的。
> **v5 改了什么**：第三轮技术复审。「被掐断」补到**六种**（多了"还没开始建工作副本"这一格，它的正确文案与"位置未确认"**相反**）；「被拒绝」不再一律画成"无事发生"（四种拒绝里有两种可能已经留下东西）；「交付状态不明」那段残留的"原样留在磁盘上/现场还在"改成"系统刻意保留"。改动在 §4.1、§4.2、§4A、§8、§10。
> **v4 改了什么**：第二轮技术复审又抓出四处会误导设计的措辞——「排队中 = 已经派了」（其实一个字都还没发给 AI）、「工作副本仍在磁盘上」（其实只是收尾时没确认清理）、少了一整类合法组合（**执行说不清、但代码确实在分支上**）、以及"被掐断"其实有更多形态。另外多了一种终态：**还没开跑就被本地拒绝**。改动在 §4.1、§4.2、§4A、§8、§10。
> **v3 改了什么**：技术复审发现 v2 有几处**事实错误**，其中三处会直接误导设计——「无改动」的措辞替 AI 编造了意图、「只读」被写成了安全承诺、中断态被写成"结果永远拿不到了"（**实际上现场往往是可恢复的**）。改动集中在 §4A、§4B、§8。
> **v2 改了什么**：产品在 v1 写完当天多了一种环节——**有的环节是真去改代码的**。带来新的状态维度、新的成功结局、必须突出的告警态，以及"排队中"状态。
