#!/usr/bin/env node
// 模板:**让 agent 真改代码**——隔离实施 → 换引擎复核 → 出 diff 给主 agent 审。
//
//   node write-worktree.mjs <仓库目录> --out <run-dir>
//
// `access:"write"` 的形态(代码保证,不是纪律):
//   · 每个 write 环节跑在**自己的 git worktree** 里 → 并发写互不碰撞
//   · 跑完自动提交到分支 `graph/<run-dir 目录名>-<其全路径指纹>/<环节 id>`,
//     导出 `<out>/nodes/<id>.diff`,删掉 worktree
//   · **graph 不替你合并** —— 合不合、怎么合是策略,归主 agent(同"环节失败怎么办"归调用方)
//
// ⚠️ 三条必知:
//   ① worktree 只能基于**已提交的 HEAD**。主树有未提交改动会**当场拒绝**(节点看不到那些改动);
//      先 commit/stash,或明确接受这一点、给该环节加 allowDirtyBase:true。
//   ② 隔离的是**默认落点**,不是一道墙:桥没有 OS 沙箱。环节普通的相对路径读写落在自己那棵树里,
//      但有 shell 的环节仍能用绝对路径 / `../..` **读、也能写**主工作区。
//      别把它当成"主工作区一个字都脏不了"——它防的是并发互踩,不是防存心越界。
//   ③ 判交付看 `workspace.outcome`(`delivered` / `no-changes` / `unknown`),
//      别自己拿 `committed` 再推一遍。

import fs from "node:fs";
import path from "node:path";
import { withBridge } from "../tools/node-core.mjs";

// ── 改这里 ────────────────────────────────────────────────────────────────────
const TIMEOUT_MS = 1200000;
const IMPLEMENTER = "claude";   // 动手改代码的
const REVIEWER = "codex";       // 复核的 —— **必须换引擎**,而且 codex 的 read 是硬只读
const TASK = `……在这里写清楚要改什么:目标、边界、完成标准。`;
// ─────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const pos = args.filter((a) => !a.startsWith("--"));
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const REPO = path.resolve(pos[0] || process.cwd());
const OUT_DIR = path.resolve(flag("out", path.join(REPO, ".graph", "run-1")));

if (!fs.existsSync(REPO)) { console.error(`仓库目录不存在:${REPO}`); process.exit(5); }
if (IMPLEMENTER === REVIEWER) { console.error(`复核者必须换引擎,不能和实施者同为 ${IMPLEMENTER}`); process.exit(5); }

const result = await withBridge(async (bridge) => {
  // ── 实施:write 档。cwd 传**仓库根目录**,库自己会把它换成隔离的 worktree。
  const impl = await bridge.runNode({
    id: "implement", agent: IMPLEMENTER, cwd: REPO, outDir: OUT_DIR,
    access: "write", timeoutMs: TIMEOUT_MS,
    // allowDirtyBase: true,   // ← 只有当你**明确接受**"节点看不到未提交改动"时才打开
    prompt:
      `${TASK}\n\n` +
      `你在一个**隔离的 git 工作树**里,放手改,不会影响别人。改完请报告:\n` +
      `  1) 改了哪些文件、各自为什么  2) 你怎么验证的  3) 还剩什么风险/没做完的`,
  });

  if (impl.status === "unknown") {
    return { halt: "实施环节状态不明(已保留现场),不要重跑,请人工看", scene: impl.scene?.dir, error: impl.error };
  }
  const ws = impl.workspace;
  if (impl.status !== "ok") {
    // 失败时改出来的东西**未必在分支上** —— 提交失败/交付物残缺时它还躺在被保留的工作区里。
    // 所以 outcome 与 workspace 路径都要如实带出来,别笼统说"代码保住了"。
    return {
      halt: `实施环节 ${impl.status}`, error: impl.error,
      outcome: ws?.outcome,
      branch: ws?.outcome === "delivered" ? ws.branch : null,
      diff: ws?.diffPath ?? null,
      workspaceKept: ws?.removed === false ? ws?.path : null,   // ← 没交付时,东西在这儿
      note: ws?.outcome === "delivered"
        ? "改动已在分支上"
        : "改动**可能**只在保留下来的工作区里,不在分支上 —— 先去 workspaceKept 看一眼",
    };
  }
  if (ws?.outcome === "no-changes") {
    return { halt: "实施环节没有改动任何文件", note: "prompt 可能不够具体,或它认为无需改动", report: impl.artifactPath };
  }

  // ── 复核:read 档 + 换引擎。**传 diff 路径,不贴 diff 正文**。
  const review = await bridge.runNode({
    id: "review", agent: REVIEWER, cwd: REPO, outDir: OUT_DIR,
    access: "read", timeoutMs: TIMEOUT_MS,
    prompt:
      `只读复核(**不要修改任何文件**)。有人在分支 ${ws.branch} 上做了一处改动。\n` +
      `改动的完整 diff 在:${ws.diffPath}\n` +
      `实施者自己的说明在:${impl.artifactPath}\n` +
      `基线是 ${ws.baseCommit}(你当前工作区就是基线状态,可以直接读原始代码对照)。\n\n` +
      `请逐条回答:①改动有没有做到它声称的事 ②有没有引入新问题(错误处理/边界/并发/资源)\n` +
      `③有没有它漏掉的必要改动 ④你的结论:可合入 / 要改 / 不该这么做。不确定就说不确定。`,
  });

  const out = {
    outDir: OUT_DIR,
    branch: ws.branch,                    // ← 主 agent 自己决定 merge / cherry-pick / 丢弃
    baseCommit: ws.baseCommit, headCommit: ws.headCommit,
    filesChanged: ws.filesChanged,
    diff: ws.diffPath,
    implReport: impl.artifactPath,
    review: { status: review.status, path: review.artifactPath },
    next: `主 agent:自己看 diff + 跑测试,再决定要不要 git merge ${ws.branch}。别只信复核结论。`,
  };
  // ⚠️ 复核没跑成也得 **halt**(否则脚本退出 0,自动化会把"实施 + 独立复核都过了"当成事实,
  // 而实际上只有实施跑完了)。unknown 另说:保留现场、**不许自动重跑**。
  if (review.status === "unknown") {
    return { ...out, halt: "复核环节状态不明(已保留现场),不要重跑,请人工看", scene: review.scene?.dir, error: review.error };
  }
  if (review.status !== "ok") {
    return { ...out, halt: `复核环节 ${review.status} —— 改动**没有**经过独立复核`, error: review.error };
  }
  return out;
});

console.log(JSON.stringify(result, null, 2));
process.exit(result.halt ? 1 : 0);
