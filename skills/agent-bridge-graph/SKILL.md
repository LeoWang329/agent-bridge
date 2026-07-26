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

完整示例见 `examples/hetero-audit.mjs`(可直接跑)。

## 组合纪律(不管走哪条都适用)

1. **循环一定要写死最大轮数 + 一个收敛条件**。不然没人叫停就一直烧钱。
2. **不需要判断的活用代码,别叫 AI**:合并、去重、排序、计票、按条件路由。
3. **结果靠文件路径传**,别把正文贴进下一个提问(大家在同一个 `cwd`,让它自己读)。
4. **汇总/评审/挑刺的环节一定换引擎**——自己评自己没意义。
5. **一次并行别超过 4 个**:不是机器扛不住,是怕挤垮主 agent 自己那条桥连接。
6. **遇到没预料到的情况就停下报告**,别写"看不懂就再跑一遍"的重试。
7. **委托 agent 改了文件,主 agent 仍要自己 `git diff` + 跑测试再报告**,不盲信。

## 五个后端的脾气(排任务单前先看)

| 后端 | 能力边界 | 派活前先确认 |
|---|---|---|
| **Codex** | 只有它的 `read` 是**真只读**(OS 沙箱);也只有它能**强制**输出格式(`schema`) | — |
| **OMP** | 软只读(shell 能写盘);不能强制格式 | 型号用 `provider/名` 全限定形式 |
| **Claude** | 同 OMP | — |
| **Cursor** | 软只读(原生写工具还在);**看不到上下文用量**;**内容进 Cursor 云端且删不掉** | 型号要带档位后缀(如 `gpt-5.3-codex-high`) |
| **Kimi** | 软只读(原生写工具还在);看不到上下文用量;**推理走 Moonshot 云端**,敏感内容照样出境 | 型号用 `kimi-code/…`;**effort 会被忽略** |

- **v1 只允许 `access:"read"`**。但这**不等于**"不可能改文件"——只有 codex 是硬拦,另外四家是软的。
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
<out-dir>/nodes/<id>.scene/          ← 只有非正常收场才有:session.log / answer.txt / status.json
```

**回执的 `specHash` 是输入指纹**——把 agent / 型号 / effort / cwd / 提问原文 / 角色文件内容 /
`schema` / `outputShape` / **`timeoutMs`** / **`reask`** 全算进去(凡是会改变执行结局的都算,
键序无关)。同 id 重跑默认被拒;加 `reuseIfSame` 则"指纹一致才复用"。

复用还要再过几道闸:**上次必须是 `ok`**(不复用失败结果)、产出文件存在且非空、**内容 SHA-256
与回执记录一致**(防文件被换过)。**没有这些,就会把上一版任务的结果当成这一版——静默出错,
最难查的一类。** 断点续跑本身 v1 不做,但指纹和内容摘要从第一天就在。

## 这一版明确不做

不做通用流程引擎(plan/DAG 格式、依赖解析、调度器)· 不做 `access:"write"` 与 worktree ·
不做跨程序断点续跑 · 不做可视化 · 不做运行中途找人确认 · 不改 dev / roundtable / loop。

⚠️ **别把"不做流程引擎"读成"不支持循环和分支"**——你自己那段 JS 里爱怎么 `for`、怎么 `if` 都行。
不做的是"替你把循环分支抽象成一套通用格式"那件事。

回归测试:`node docs/repro-mcp-hang/repro-graph-node.mjs`(假后端,零消耗,推送前必过)。
