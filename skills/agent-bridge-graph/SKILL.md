---
name: agent-bridge-graph
description: 用 agent-bridge 把「一个环节 = 一个 AI 干一件事」做成可靠的执行原语,并支持为某次任务临时写一段 JS 来编排流程(循环/分支/过滤用普通代码,判断才叫 AI),节点可以是 codex / omp / claude / cursor / kimi 的任意组合。仅当用户明确要求「多个不同引擎的 AI 分头干再汇总 / 一个 AI 挑另一个的刺 / 几个 AI 抢答同一题」,或流程复杂到主 agent 手工驱动会出错(环节多、要循环、要按结果分支、中间产出大)时使用。普通并行委托直接用 agent-bridge 本体;多轮讨论收敛用 agent-bridge-roundtable;合同驱动的交付闭环用 agent-bridge-loop。**不要因为出现「工作流 / workflow / 图 / graph」这类词就触发**——Claude Code 自带的 Workflow 是另一回事。
---

# Agent Bridge Graph

**这一版提供的是「多 AI 协作的积木块」**——把"叫一个 AI 干一件事"做到万无一失,并让你用普通 JS 编排它们。
**这一版不提供流程图引擎**(没有 plan/DAG 格式、没有依赖解析、没有调度器),也**不是** Claude Code 自带的那个「动态工作流」。

## 什么时候用(先分诊,命中就停)

| 你的情况 | 用什么 |
|---|---|
| 一个 AI 就能干完 | **别用**,直接用 `agent-bridge` 本体 |
| 要几个 AI 多轮讨论、互相看发言、收敛出结论 | `agent-bridge-roundtable` |
| 要「从挖需求到全部验收通过」的端到端闭环 | `agent-bridge-loop` |
| 活儿全能由 Claude 干、不需要不同引擎 | Claude Code 自带的 Workflow(更成熟) |
| 要**不同引擎**的 AI 分头干 / 互相挑刺 / 抢答 | **本 skill** ✅ |

**一句话判据:这件事的价值,是不是来自「这些 AI 不是同一个脑子」?**

⚠️ 那些"分头查再汇总""一个干一个挑刺"的**形状**,光用桥本体也摆得出来(开 N 个会话 + `wait`)。
**本 skill 换的是流程的载体**,不是形状。所以真正的切换线是下面这个:

## 什么时候该从「手工驱动」切到「写脚本」

命中任意一条就写脚本(否则老实用桥本体,别为用工具而用工具):

- **环节数 ≥ 5~6** —— 再多,光记"谁跑完了谁没跑完"就开始出错
- **要循环**(不确定几轮)或**要按结果分支**
- **中间产出大**(每个环节几千字)—— 手工驱动会把这些正文全灌进主 agent 上下文
- **这个流程要跑不止一次**

| | 手工驱动 | 写 JS 脚本 |
|---|---|---|
| 流程写在哪 | 主 agent 上下文(会被挤掉、会漂) | 一个文件(不会忘) |
| 中间结果 | **每份都进主 agent 上下文** | JS 变量 + 磁盘,主 agent 一个字不看 |
| 循环/条件 | 靠自觉,**可能被 prompt 说服跳过** | `for`/`if`,**不会被说服** |
| 能重跑吗 | 不能 | 能 |

## 怎么用

### 写法一:命令行跑一个环节(简单情况)

```sh
node tools/node-turn.mjs --id audit-auth --agent codex --cwd D:/repo \
  --prompt "审计 auth.ts 的权限校验" --timeout-ms 600000 --out-dir D:/repo/.graph/run-1
```

退出码:`0` 成功 · `1` 崩了 · `2` 格式不合格 · `3` 后端挂 · `4` 超时 · `5` 用法错 · `6` 未知状态(已停下保留现场)。
完整 flag 见 `tools/README.md`。

### 写法二:临时写一段 JS 编排(**主力用法**)

```js
import { withBridge } from "<本目录>/tools/node-core.mjs";

const out = await withBridge(async (bridge) => {
  const rs = await Promise.all(FILES.map((f, i) =>          // 扇出
    bridge.runNode({ id: `audit-${i}`, agent: "codex", cwd, outDir,
                     prompt: `审计 ${f}`, timeoutMs: 600000 })));

  const ok = rs.filter(r => r.status === "ok");             // 过滤:普通代码,不叫 AI
  if (ok.length < 2) return { halt: "挂太多,先查环境" };     // 分支:普通 if

  return bridge.runNode({ id: "sum", agent: "kimi", cwd, outDir, timeoutMs: 600000,
    prompt: `读这几份结果并汇总:${ok.map(r => r.artifactPath).join(" ")}` });
});
```

一个 `withBridge` = **一个**桥进程(里面爱跑几个环节都行),用完自动关干净。
`runNode` **不为环节失败抛异常**,返回带 `status` 的回执(`ok`/`contract_error`/`backend_failed`/`timeout`/`unknown`)——
因为"一个环节挂了怎么办"是策略、归你(圆桌是带缺口继续、loop 是换引擎重开,没有统一答案)。只有**用法错**才抛。

⚠️ **别从零写这段 JS。`templates/` 里有骨架,拷一份改**——从零写每次都会漏掉同一批东西
(无界重试、把正文贴进下一个 prompt、自己评自己)。规范与反模式清单见 `templates/README.md`。

| 你要做的事 | 拷这个 |
|---|---|
| 几家分头查 → 汇总 | `examples/hetero-audit.mjs`(可直接跑,也是本 skill 的真跑 e2e) |
| 跑一段 → **主 agent 看结果决定下一步** → 再跑一段 | `templates/wave.mjs` |
| 让 agent 真改代码(隔离 + 出 diff 给你审) | `templates/write-worktree.mjs` |

### 写法三:分波——要主 agent 中途拿主意时

**脚本一旦启动,主 agent 就出局了**,只能等它返回;没有"跑到一半回来问主 agent"这回事(见 §二期)。
要中途决策,就把决策点切在**波与波之间**:

```
第 1 波脚本 → 返回摘要 → 主 agent 看结果、决定下一步 → 第 2 波脚本(同一个 outDir)
```

已完成的环节在第 2 波里**原样再声明一遍**,靠 `reuseIfSame:true` + 稳定的 `id` **本地秒判复用**
(不发任何模型请求),所以每一波都能"从头声明整张图"。灵活度全在主 agent 手里,而中间产出仍然一个字不进上下文。

⚠️ 必知的坑:`reuseIfSame` 只在**指纹完全一致**时复用;prompt 改一个字它**不重跑,而是抛 UsageError**。
所以已完成的环节 spec 保持原样、新工作用新 `id`;确实要重做同一个 id 就明确加 `force:true`。
也因此 **`id` 里不要带时间戳/随机数**——那会让复用永远命不中,分波退化成每次全量重跑。

骨架见 `templates/wave.mjs`。

## 组合纪律(不管走哪条都适用)

前两条**代码已经替你保证**(写错当场报错),其余靠你:

1. ✅ **一次并行不超过 `maxConcurrent`(默认 4)** —— 已是机制:超限的 `runNode` **自动排队**,
   不报错也不用你改写法(照写 `Promise.all` 就行),**别自己再搓一层限流**。
   要调:`withBridge(fn, { maxConcurrent: 2 })`。为什么是 4:不是机器扛不住,是怕挤垮主 agent 自己那条桥连接。
2. ✅ **`timeoutMs` 必填,且是总上限** —— 「wait 必传超时」这条纪律由代码保证,不再靠人记。
3. **循环一定要写死最大轮数 + 一个收敛条件**。不然没人叫停就一直烧钱。
4. **不需要判断的活用代码,别叫 AI**:合并、去重、排序、计票、按条件路由。
5. **结果靠文件路径传**,别把正文贴进下一个提问(大家在同一个 `cwd`,让它自己读)。
6. **汇总/评审/挑刺的环节一定换引擎**——自己评自己没意义。
7. **遇到没预料到的情况就停下报告**,别写"看不懂就再跑一遍"的重试。
   尤其 **`unknown` 不是"一种失败"**,是"不知道后端干没干"——重跑可能让同一件事做两遍,停下等人。
8. **委托 agent 改了文件,主 agent 仍要自己 `git diff` + 跑测试再报告**,不盲信。
9. ⚠️ **节点之间没有记忆** —— 每个 `runNode` 都是「开会话 → 发一条 → 关会话」,下一个节点是
   **全新上下文**(节点内唯一的多轮是 `reask`,且只为格式不合格)。这是刻意的:回执的 `specHash`
   承诺「同样的输入 → 同样的执行」,节点要是能记住上一轮,结果就取决于**看不见的会话状态**,
   指纹当场变成谎言、`reuseIfSame` 会复用一个复现不出来的结果。
   **所以复审→修订这类多轮任务,"记忆"必须显式化成输入**(三样缺一不可,见
   `templates/review-fix-loop.mjs`):①上一轮的产出(`baseRef` 指向它的分支)②上一轮节点
   **自己的回答** `<outDir>/nodes/<id>.md`(那是它外化出来的推理,最接近记忆的东西)
   ③**主 agent 的裁定**——复审意见**不能原样转发**,哪条认哪条驳得有人拍板,否则修订节点
   会把你上一轮明确驳回过的意见也一并"修好"。

## 改代码的环节:`access:"write"` = git worktree

**`write` 恒定跑在自己的 git worktree 里,没有"在主工作区写"这个选项。** 这是代码保证的,不是纪律——
扇出是核心用法,N 个环节共享一个 `cwd` 同时改文件必然互相踩。

```js
bridge.runNode({ id: "implement", agent: "claude", cwd: REPO, outDir,
                 access: "write", timeoutMs: 1200000, prompt: "…" });
```

`cwd` 传**仓库根目录**即可,库自己换成隔离工作树。跑完自动:

```
提交到分支 graph/<outDir 目录名>-<其全路径指纹>/<环节 id>
导出       <out-dir>/nodes/<id>.diff        ← 给人/复核环节看
删掉       worktree —— 但**只在两个前提都满足时**:①工作区状态已确认(要么交付物完整=提交成功且
           head/改动清单/diff/摘要四样齐全,要么确知一个字都没改)②后端确定不会再写(关会话被确认,
           或桥明确回报会话没建起来)。缺任一就保留目录并说明原因(留着只是脏,删错了是丢代码)。
           「确知没改动」那条还会顺手删掉那条指向基线的空分支;「已交付」那条**保留分支**。
```

> 分支名里那段指纹取自 outDir 的**全路径** —— 否则 `…/a/run-1` 和 `…/b/run-1` 会算出同一个名字,
> 两次运行撞进同一棵工作树;带 `force` 时后到的那个会把前一个正在写的树直接删掉。

**graph 不替你合并** —— 合不合、怎么合是策略,归主 agent(同"环节失败怎么办"归调用方)。
回执的 `workspace` 块里有 `outcome` / `branch` / `baseCommit` / `headCommit` / `changesKnown` /
`filesChanged` / `diffPath` / `diffSha256`。**`outcome` 是唯一权威结论**(`delivered` = 改动已落到分支且
交付物齐全 / `no-changes` = 确知一个字都没改 / `unknown` = 其余一切),别自己拿 `committed` 加
`filesChanged` 再推一遍。

七条必知:

- **基线是已提交的 `HEAD`**(可用 `baseRef` 改)。主树**有未提交改动时当场拒绝**并列出哪些文件节点看不到 ——
  先 `git commit`/`stash`,或明确接受这一点、加 `allowDirtyBase:true`。脏树在**开跑前查两次**
  (排队前一次、拿到并发闸之后再一次),因为扇出时一个环节可能在闸外等好几分钟。
  每个环节钉在**调用 `runNode()` 那一刻**解析出的 commit 上(不是它真正开跑那一刻 —— 基线在排队**之前**
  就解析好了,排队期间 HEAD 再动也不影响已经排上队的环节)。所以 `Promise.all` 一次扇出的那批
  拿到的是同一个基线;而**下一波**才调用的环节会解析到那时的 HEAD。要绝对钉死就直接传具体 commit 当 `baseRef`。
- **隔离的是「默认落点」,不是一道墙**:桥没有 OS 沙箱。worktree 换掉的是环节的 `cwd`,所以它**普通的
  相对路径读写**都落在自己那棵树里;但有 shell 的环节仍然能用**绝对路径 / `../..` 读、也能写**主工作区,
  还能碰到共享的 git 公共目录。**别把它当成"主工作区一个字都脏不了"的保证** —— 它防的是"N 个环节
  同时改同一份文件"这种互踩,不是防一个存心越界的 agent。
- **复用要多过几道闸**:`baseRef` 通常是 `"HEAD"`,它今天和上周解析到的是两个 commit,而 `specHash` 里只有
  字符串 `"HEAD"`——一模一样。所以 write 复用时还要比对 **`baseCommit`**、**分支仍指向回执记的 `headCommit`**、
  **diff 文件还在且指纹对得上**;**脏树闸对复用同样生效**(否则同一个脏工作区下真跑被拒、复用却照样交货)。
- **交付物没能确认落到分支上时,环节状态被降级成 `unknown`**(哪怕模型那一轮跑得好好的)。判据是
  `workspace.outcome`:只有 `delivered` 与 `no-changes` 算数。因为 write 环节的交付物不只是那段文字,
  还包括"改动确实落到了分支上,而且我们记全了它的坐标";报 `ok` 会让调用方、以及 `reuseIfSame` 那道
  "只复用 ok"的闸,把一个**没有产出的 write 环节**当成功并在其上继续往下建。按纪律:停下等人,**不自动重跑**。
  ⚠️ 注意"提交成功"**不等于**交付完成:head / 改动清单 / diff / diff 摘要任缺一样,交付物就是残的,
  照样降级并保留工作区。
- **agent 自己动 git 是允许的,但会改变收尾方式**:它自己 `git commit` 过没问题 —— 工具按
  **基线到 HEAD 的全部**算交付,不是只算"我们刚提交的那一笔"。但它要是**把 HEAD 切走了**
  (换分支 / detached),交付物落在哪就无法判定,这时工具**什么都不删**、状态给 `unknown`、
  把工作树留在原地等人看。
- **`git add -A` 不是"天然安全"**:agent 在工作树里留下的**一切未被 gitignore 的东西**都会进提交、并出现在
  导出的 diff 里 —— 跑测试产生的 `coverage/`、临时文件、它自己写的 `.env` 都算。这是刻意的(它新建的文件通常
  正是产物),但**仓库 gitignore 不全时会有噪声甚至敏感文件入库**。所以务必看 `filesChanged`,合并前自己过一遍 diff。
- **`.graph/` 请加进仓库的 `.gitignore`**(worktree 与产出都落在那)。不加也能跑——脏树判定排掉的是
  **「`.graph/wt` 与 `<outDir>/nodes` 底下、且未被跟踪的」**那些条目,也就是本工具自己造出来的东西;
  **任何被跟踪文件的改动一律算脏**,哪怕它正好落在这两条路径下。(按目录整片排是危险的:outDir 是你给的
  任意目录,设成 `repo/src` 之类就会把真实源码改动一起吞掉——一道安全闸被自己的排除项悄悄关掉。)
  ——但你的 `git status` 会一直不干净。
- **worktree 偶尔删不掉**(Windows 上杀毒/备份进程占着目录)。这时回执里 `removed:false`、
  diagnostics 会说明,**代码已经安全地在分支上**,只是目录残留需要你自己
  `git worktree remove --force <path>`。

## 五个后端的脾气(排任务单前先看)

| 后端 | 能力边界 | 派活前先确认 |
|---|---|---|
| **Codex** | 只有它的 `read` 是**真只读**(OS 沙箱);也只有它能**强制**输出格式(`schema`) | — |
| **OMP** | 软只读(shell 能写盘);不能强制格式 | 型号用 `provider/名` 全限定形式 |
| **Claude** | 同 OMP | — |
| **Cursor** | 软只读(原生写工具还在);**看不到上下文用量**;**内容进 Cursor 云端且删不掉** | 型号要带档位后缀(如 `gpt-5.3-codex-high`) |
| **Kimi** | 软只读(原生写工具还在);看不到上下文用量;**推理走 Moonshot 云端**,敏感内容照样出境 | 型号用 `kimi-code/…`;**effort 会被忽略** |

- **`access` 两档:`read`(默认)与 `write`**(= git worktree,见上一节)。⚠️ `read` **不等于**"不可能改文件"
  ——只有 codex 是硬拦(OS 沙箱),另外四家是软的:shell 能写盘,cursor/kimi 连原生写工具都还在。
  **要硬保证不写盘的环节,就点名 codex。**
- **关键判断环节(挑刺/裁判/汇总)别用 cursor 和 kimi**(每轮短进程,角色设定容易飘);让它们干普通生产环节。
- **敏感内容的任务,一开始就别把 cursor / kimi 排进去。**
- **`schema` 只有 codex 能用**,传给别人会被当场拒绝;其余四家用 `outputShape`(工具做弱检查:
  能不能 parse + 顶层必需键在不在)。**弱检查不是完整校验**,别指望它给出 codex 那种保证。
- 开跑前先 `bridge.doctor()`;但 doctor **只查版本号**,过了也可能起不来(不验登录)。

## 产物长什么样

```
<out-dir>/nodes/<id>.md              ← 这个环节的完整产出(字节直传,未截断)
<out-dir>/nodes/<id>.receipt.json    ← 回执(含输入指纹 specHash)
<out-dir>/nodes/<id>.diff            ← 只有 write 环节才有:这次改动的完整 patch
<out-dir>/nodes/<id>.scene/          ← 只有非正常收场才有:session.log / answer.txt / status.json
<repo>/.graph/wt/<run>/<id>/         ← write 环节的隔离工作树(跑完即删,请 gitignore `.graph/`)
```

**回执的 `specHash` 是输入指纹**——把 agent / 型号 / effort / access / cwd / 提问原文 / 角色文件内容 /
`schema` / `outputShape` / **`timeoutMs`** / **`reask`** / **`baseRef`** 全算进去(凡是会改变执行结局的都算,
键序无关)。同 id 重跑默认被拒;加 `reuseIfSame` 则"指纹一致才复用"。

复用还要再过几道闸:**上次必须是 `ok`**(不复用失败结果)、产出文件存在且非空、**内容 SHA-256
与回执记录一致**(防文件被换过)、write 环节还要**基线 `baseCommit` 没变**。**没有这些,就会把上一版任务的
结果当成这一版——静默出错,最难查的一类。**

## 这一版明确不做

不做通用流程引擎(plan/DAG 格式、依赖解析、调度器)· 不做可视化 ·
不做跨程序断点续跑(但**分波 + `reuseIfSame` 已经能当续跑用**,见写法三)· 不改 dev / roundtable / loop ·
**不做运行中途找人/找主 agent 确认**(见下)。

⚠️ **别把"不做流程引擎"读成"不支持循环和分支"**——你自己那段 JS 里爱怎么 `for`、怎么 `if` 都行。
不做的是"替你把循环分支抽象成一套通用格式"那件事。

### 二期:运行中途找主 agent / 找人拿主意

**当前不支持。** 脚本作为子进程启动后,主 agent 只能等它返回;环节跑到一半时没有任何回传决策的通道。

**今天的替代**是**分波**(写法三):把决策点切在波与波之间,靠 `reuseIfSame` 避免重跑。它覆盖了绝大多数
"根据结果决定下一步"的场景,**唯一覆盖不到的**是:**单个环节跑到一半就需要拍板**(比如它问"这两个方案选哪个")。

二期做的话形态大致是:脚本 append 一条"待决"事件并阻塞,主 agent 看到后回写答案文件,脚本继续。
在那之前——**别在脚本里写等人输入的逻辑**(会一直挂到超时),把它拆成两波。

回归测试(假后端,零消耗,推送前必过):

```sh
node docs/repro-mcp-hang/repro-graph-node.mjs        # 环节生命周期 / 失败三档 / 幂等 / 零残留
node docs/repro-mcp-hang/repro-graph-worktree.mjs    # write 隔离 / 基线闸 / 复用闸 / 并发闸
```
