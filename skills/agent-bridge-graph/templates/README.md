# 编排脚本规范

**先拷模板改，不要从零写。** 从零写每次都会漏掉同一批东西——不是能力问题，是这些约束不写下来就记不住。

| 你要做的事 | 拷这个 |
|---|---|
| 几家分头查同一个东西 → 汇总 | `../examples/hetero-audit.mjs`（可直接跑，也是本 skill 的真跑 e2e） |
| 跑一段 → **主 agent 看结果决定下一步** → 再跑一段 | `wave.mjs` |
| 让 agent 真改代码（隔离 + 出 diff 给你审） | `write-worktree.mjs` |

---

## 十条硬规则

前四条**代码已经替你保证**了，写错会当场报错；后六条靠你自己。

| # | 规则 | 谁保证 |
|---|---|---|
| 1 | `timeoutMs` 必填，且是**总**上限（不是只管 wait 那一段） | ✅ 代码 |
| 2 | 一次并行不超过 `maxConcurrent`（默认 4） | ✅ 代码（超了自动排队，别自己搓限流） |
| 3 | 同一个 `outDir` 里 `id` 不能重复 | ✅ 代码（进程内 + 跨进程锁） |
| 4 | `access:"write"` 恒定跑在自己的 git worktree 里 | ✅ 代码（隔离的是**默认落点**,不是 OS 沙箱） |
| 5 | **循环必须写死最大轮数 + 一个收敛条件** | ❌ 你 |
| 6 | **不需要判断的活用代码**：过滤、去重、排序、计票、路由 | ❌ 你 |
| 7 | **结果靠 `artifactPath` 传**，别把正文贴进下一个 prompt | ❌ 你 |
| 8 | **汇总/评审/挑刺一定换引擎**，自己评自己没意义 | ❌ 你 |
| 9 | **遇到没预料到的状态就停下报告**，别写"看不懂就再跑一遍" | ❌ 你 |
| 10 | 脚本**只 `return` 一小坨摘要**，中间产出不进任何人的上下文 | ❌ 你 |

## 五个反模式（见到就是写错了）

```js
// ❌ 把正文贴进下一个 prompt —— 中间产出全进了上下文,这个 skill 的价值就没了
prompt: `根据这份审计结果:${audits[0].text} ...`
// ✅ 传路径,让它自己读(大家在同一个 cwd)
prompt: `读 ${audits[0].artifactPath} 然后 ...`

// ❌ 自己搓限流 —— 现在是机制,重复实现只会打架
for (const chunk of chunks(files, 4)) await Promise.all(...)
// ✅ 照写 Promise.all,超限的自动排队
await Promise.all(files.map(f => bridge.runNode(...)))

// ❌ 自己推断 write 环节到底交付了什么 —— 两处各推一遍,迟早推出两种结论
if (r.workspace?.committed && r.workspace.filesChanged.length) { merge(r.workspace.branch) }
// ✅ 只看唯一权威结论
if (r.workspace?.outcome === "delivered") { /* 改动确实在 r.workspace.branch 上 */ }

// ❌ 无界重试 —— 没人叫停就一直烧钱
while (r.status !== "ok") r = await bridge.runNode(spec)
// ✅ 写死上限 + 收敛条件(见 wave.mjs)
for (let round = 1; round <= MAX_ROUNDS && !converged; round++) { ... }

// ❌ 拿 unknown 当可重试的失败 —— 分不清后端干没干时重跑 = 同一件事做两遍
if (r.status !== "ok") return retry(r)
// ✅ 三档分开处置(backend_failed 可换引擎重跑;unknown 停下等人)
if (r.status === "unknown") return { halt: "状态不明,已保留现场,请人工看", scene: r.scene }

// ❌ 自己评自己
const sum = await bridge.runNode({ agent: SAME_AGENT, prompt: "汇总上面几份" })
// ✅ 换一个没下场的引擎(拿不到就停,不退而求其次)
```

## 关于「主 agent 中途介入」

**脚本一旦启动，主 agent 就出局了**，只能等它返回——没有"跑到一半问主 agent"这回事（见 SKILL.md §二期）。

要中途决策，用 **`wave.mjs` 的分波模式**：跑一波 → 脚本返回 → 主 agent 看结果决定 → 再跑一波。已完成的环节靠 `reuseIfSame` 指纹**本地秒判复用**，不重跑、不花钱。

⚠️ 分波有个必知的坑：`reuseIfSame` 只在**指纹完全一致**时复用，prompt 改一个字它不会重跑而是**抛 UsageError**。所以——**已完成的环节 spec 保持原样，新工作用新 `id`**；确实要重做同一个 id，明确加 `force:true`。

## `id` 怎么起

`id` 不只是个名字，它同时是**产出文件名**、**write 环节的分支名**、以及**复用的键**。所以：

- 有意义、稳定（`audit-auth` 好过 `node1`）——分波重跑时靠它对上
- 只用 `A-Za-z0-9._-`
- **不要带时间戳/随机数**——那会让 `reuseIfSame` 永远命不中，分波退化成每次全量重跑
