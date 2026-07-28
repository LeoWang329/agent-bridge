#!/usr/bin/env node
// 模板:**复审 → 修订 → 再复审**,反复几轮直到通过。
//
//   node review-fix-loop.mjs <repo> --out <run-dir> --round 1
//   node review-fix-loop.mjs <repo> --out <run-dir> --round 2 --decisions <绝对路径>
//
// ⚠️ **这个模板存在的唯一理由:节点之间没有记忆。**
//
// 每个 runNode 都是「开会话 → 发一条 → 关会话」,下一个节点是**全新上下文**,对上一轮
// 想过什么、纠结过什么一无所知(节点内唯一的多轮是 `reask`,而且只为格式不合格)。
// 这不是遗漏,是刻意的:回执的 `specHash` 承诺「同样的输入 → 同样的执行」。要是节点能
// 记住上一轮,结果就取决于**看不见的会话状态**,指纹立刻变成谎言,`reuseIfSame` 会复用
// 一个其实复现不出来的结果。
//
// 所以多轮任务里,"记忆"必须**显式化成输入**。三样缺一不可:
//
//   1. 上一轮的产出本身   → `baseRef` 指向上一轮的分支,修订节点的 worktree 直接建在它上面
//   2. 上一轮节点自己的回答 → `<out>/nodes/<id>.md`,那是它**外化出来的推理**(当时纠结了
//                            什么、留了哪些存疑)。这是最接近"记忆"的东西,而且已经在磁盘上
//   3. **主 agent 的裁定**  → 复审意见**不能原样转发**。哪几条认、哪几条驳、驳的理由是什么
//
// 第 3 条最容易省掉,也最致命:少了它,修订节点会把复审里每一条都当圣旨照收 —— 包括你
// 上一轮明确驳回过的那几条。**它没有上下文分辨哪条该驳。**
//
// ⚠️ 另一个必踩的坑:write 节点跑在 worktree 里,而 `.graph/` 一般被 gitignore ——
// 上面那些文件**在它的 cwd 里根本不存在**。给**绝对路径**,并明说用 shell 读。

import fs from "node:fs";
import path from "node:path";
import { withBridge } from "../tools/node-core.mjs";

// ── 改这里 ────────────────────────────────────────────────────────────────────
const TARGET = "path/to/your-file.md";      // 被反复修订的东西
const FIX_AGENT = "claude";                 // 写的那个
const REVIEW_AGENT = "codex";               // 挑刺的那个(**必须换引擎**)
const FIX_MS = 2_400_000;
const REVIEW_MS = 1_800_000;
const TASK = `……这份文件要满足的合同(每轮原样重述,别指望它记得)`;
// ─────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const REPO = path.resolve(args.filter((a) => !a.startsWith("--"))[0] || process.cwd());
const OUT = path.resolve(flag("out", path.join(REPO, ".graph", "review-loop")));
const ROUND = Number(flag("round", "1"));
const DECISIONS = flag("decisions", null);   // 主 agent 写的裁定档(绝对路径)
const BASE = flag("base", null);             // 上一轮的分支;第 1 轮不传

if (ROUND > 1 && !DECISIONS) {
  console.error("第 2 轮起必须传 --decisions:复审意见不能原样转发,得先有人裁。");
  process.exit(5);
}

const prevReport = path.join(OUT, "nodes", `fix-r${ROUND - 1}.md`);
const prevReview = path.join(OUT, "nodes", `review-r${ROUND - 1}.md`);

const fixPrompt = ROUND === 1
  ? `${TASK}\n\n交付:写出 \`${TARGET}\`。完成后在回答里说明:①你做了什么取舍;②哪些地方**你找不到依据**(存疑清单,别自己拍板补进去)。`
  : `你要修订 \`${TARGET}\`。⚠️ **你没有上一轮的记忆**,下面这些文件就是上一轮的全部上下文,
**先按顺序读完再动手**(它们在你的工作目录之外,用 shell 读绝对路径):

\`\`\`sh
cat "${DECISIONS}"     # ← 主 agent 的裁定:哪些照改、哪些**明确不改**及理由。以它为准
cat "${prevReview}"    # ← 复审原文(供你理解上下文,**不是**待办清单)
cat "${prevReport}"    # ← 上一轮写它的人自己的说明:取舍与存疑
\`\`\`

⚠️ **裁定档的优先级高于复审原文。** 复审里凡是被裁定驳回的,**保持现状**——那些是上几轮
已经论证过的决定,重新"修好"它等于把结论倒回去。裁定没提到的条目,按复审改。

${TASK}

完成后说明:①逐条对照裁定做了什么;②哪几条你**没照做**及为什么;③新的存疑。`;

const run = async () => {
  fs.mkdirSync(OUT, { recursive: true });
  return withBridge(async (bridge) => {
    const fix = await bridge.runNode({
      id: `fix-r${ROUND}`, agent: FIX_AGENT, access: "write",
      cwd: REPO, outDir: OUT, effort: "xhigh", timeoutMs: FIX_MS,
      ...(BASE ? { baseRef: BASE } : {}),        // ← 记忆之一:直接站在上一轮的产出上
      prompt: fixPrompt,
    });
    if (fix.status !== "ok" || fix.workspace?.outcome !== "delivered") {
      return { halt: `第 ${ROUND} 轮没交付,停下看现场`, status: fix.status, outcome: fix.workspace?.outcome };
    }

    const branch = fix.workspace.branch;
    const review = await bridge.runNode({
      id: `review-r${ROUND}`, agent: REVIEW_AGENT, access: "read",
      cwd: REPO, outDir: OUT, effort: "xhigh", timeoutMs: REVIEW_MS,
      prompt: `对抗性复审。**只读,不要改任何文件。**

待审的东西还没合进主干,在分支 \`${branch}\` 上:

\`\`\`sh
git show ${branch}:${TARGET}
\`\`\`

${TASK}

给 APPROVE 或 CHANGES-REQUIRED,按 BLOCKER / MAJOR / MINOR 分级。每条都要指出**具体在哪、错在哪、应该是什么**。只给必须改的,不给可选改进项。`,
    });

    // 收敛判据由**主 agent** 看 review 决定,脚本不猜(它读不懂"APPROVE"是不是真心的)。
    return { round: ROUND, branch, fix: fix.status, review: review.status, reviewAt: review.artifactPath };
  }, { maxConcurrent: 2 });
};

run().then((r) => console.log(JSON.stringify(r, null, 1)));
