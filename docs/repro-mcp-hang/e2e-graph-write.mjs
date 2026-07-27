// END-TO-END(真后端、真模型、真花钱):agent-bridge-graph 的 `access:"write"` worktree 路径。
//
//   node docs/repro-mcp-hang/e2e-graph-write.mjs [--impl claude] [--review codex] [--keep]
//
//   --keep 跑完不删临时仓库,你可以自己 cd 进去 git log / git show / 跑测试核对,
//          而不是只能信这份输出(推荐第一次跑的时候加上)。
//
// 与 hermetic 的 repro-graph-worktree.mjs 的分工:那份证**机制**(用假后端造各种边界),
// 这份证**真的能干活** —— 让一个真模型在隔离工作树里修一个**有确定性测试的 bug**,
// 然后由机器验证:①分支上的代码确实让测试通过了 ②主工作区一个字没动 ③导出的 diff 能 apply。
//
// ⚠️ 花真 token。缺后端时**干净 SKIP(exit 0)**,不是 FAIL。

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withBridge, UsageError } from "../../skills/agent-bridge-graph/tools/node-core.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const IMPL = flag("impl", "claude");
const REVIEW = flag("review", "codex");
const NODE_TIMEOUT_MS = Number(flag("timeout-ms", "600000"));
const KEEP = argv.includes("--keep"); // 留下临时仓库,人可以自己进去核对(默认跑完就删)

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { if (c) { pass++; console.log(`[PASS] ${n}`); } else { fail++; console.log(`[FAIL] ${n}${d ? ` — ${d}` : ""}`); } };

function sh(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", windowsHide: true });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim(), code: r.status };
}
const g = (args, cwd) => sh("git", args, cwd);

// ── 被修的东西:一个跳过首元素的 sum + 一个会失败的测试 ──────────────────────────
const BUGGY_SUM = `// 求和
export function sum(nums) {
  let total = 0;
  for (let i = 1; i < nums.length; i++) total += nums[i];
  return total;
}
`;
const TEST = `import { sum } from "./sum.mjs";
const cases = [[[1, 2, 3], 6], [[5], 5], [[], 0], [[-1, 1], 0]];
let bad = 0;
for (const [input, want] of cases) {
  const got = sum(input);
  if (got !== want) { console.log(\`FAIL sum(\${JSON.stringify(input)}) = \${got}, want \${want}\`); bad++; }
}
if (bad) { console.log(\`\${bad} case(s) failed\`); process.exit(1); }
console.log("ALL_PASS");
`;

function makeRepo(root) {
  fs.mkdirSync(root, { recursive: true });
  g(["init", "-q", "-b", "main"], root);
  g(["config", "user.name", "graph-e2e"], root);
  g(["config", "user.email", "graph-e2e@local"], root);
  fs.writeFileSync(path.join(root, "sum.mjs"), BUGGY_SUM, "utf8");
  fs.writeFileSync(path.join(root, "test.mjs"), TEST, "utf8");
  fs.writeFileSync(path.join(root, ".gitignore"), ".graph/\n", "utf8");
  g(["add", "-A"], root);
  g(["commit", "-qm", "init (with the bug)"], root);
}

/** 把某个 ref 上的 sum.mjs 取出来,配上**原始**测试跑一遍。
 *  刻意用原始 test.mjs 而不是分支上的 —— 否则模型改了测试也能"通过"。 */
function verifyRef(repo, ref, tmpDir) {
  fs.mkdirSync(tmpDir, { recursive: true });
  const show = g(["show", `${ref}:sum.mjs`], repo);
  if (!show.ok) return { ok: false, why: `取不到 ${ref}:sum.mjs — ${show.err}` };
  fs.writeFileSync(path.join(tmpDir, "sum.mjs"), show.out + "\n", "utf8");
  fs.writeFileSync(path.join(tmpDir, "test.mjs"), TEST, "utf8");
  const r = sh(process.execPath, ["test.mjs"], tmpDir);
  return { ok: r.ok && r.out.includes("ALL_PASS"), why: `${r.out} ${r.err}`.trim().slice(0, 200) };
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "graph-e2e-write-"));
let exitCode = 1;
try {
  // ── 0. 体检 ────────────────────────────────────────────────────────────────
  const doc = await withBridge((b) => b.doctor(), {});
  const docText = doc?._raw || JSON.stringify(doc);
  const have = (n) => new RegExp(`${n}:\\s*ok`, "i").test(docText);
  if (!have(IMPL) || !have(REVIEW)) {
    console.log(`>>> SKIP: 需要 ${IMPL} 与 ${REVIEW} 都可用(impl=${have(IMPL)}, review=${have(REVIEW)})`);
    process.exit(0);
  }
  console.log(`[info] 实施=${IMPL} 复核=${REVIEW};临时仓库 ${ROOT}`);

  const repo = path.join(ROOT, "repo");
  const outDir = path.join(repo, ".graph", "run-1");
  makeRepo(repo);

  // 先证明"基线确实是坏的" —— 否则后面"修好了"这个断言是空的
  const before = verifyRef(repo, "HEAD", path.join(ROOT, "check-before"));
  ok("基线确实跑不过测试(否则本次 e2e 是空的)", before.ok === false, before.why);

  // ── 1. 真实施:write 环节 ───────────────────────────────────────────────────
  const impl = await withBridge((b) => b.runNode({
    id: "fix-sum", agent: IMPL, cwd: repo, outDir,
    access: "write", timeoutMs: NODE_TIMEOUT_MS,
    prompt:
      `这个仓库里有一个 bug。\n\n` +
      `跑 \`node test.mjs\` 你会看到失败。请**只改 sum.mjs**修好它,让 \`node test.mjs\` 输出 ALL_PASS。\n` +
      `**不要修改 test.mjs**(那是验收标准)。改完自己跑一遍确认通过,然后一句话说明原因。`,
  }), {});

  ok("write 环节 status=ok", impl.status === "ok", `${impl.status} ${impl.error ?? ""}`);
  const ws = impl.workspace;
  ok("有 workspace 块且是 worktree 模式", ws?.mode === "worktree", JSON.stringify(ws)?.slice(0, 140));
  ok("交付结论是 delivered", ws?.outcome === "delivered", `${ws?.outcome} ${JSON.stringify(ws?.filesChanged)}`);
  // runKey = outDir 目录名 + 其全路径的 8 位指纹(防止不同 outDir 重名撞同一条分支)
  ok("分支名符合约定", /^graph\/run-1-[0-9a-f]{8}\/fix-sum$/.test(ws?.branch || ""), ws?.branch);

  // ★ 真正的验收:分支上的代码 + **原始**测试 → 必须通过
  const after = verifyRef(repo, ws?.branch || "HEAD", path.join(ROOT, "check-after"));
  ok("★ 分支上的代码让原始测试通过了(真模型真修好了)", after.ok, after.why);

  // ⚠️ 断言**改动集恰好等于 {sum.mjs}**,不能只写"没动 test.mjs" —— 后者对"顺手多改/多写了
  // 别的文件"完全没有判别力(模型丢个 notes.md、改个 package.json 照样通过),而 `git add -A`
  // 会把工作树里一切没被 gitignore 的东西都提交进来,正是最该盯住的地方。
  const changed = (ws?.filesChanged || []).map((f) => f.path).sort();
  ok("★ 改动集恰好只有 sum.mjs(test.mjs 这把尺子没被动过,也没夹带别的文件)",
    changed.length === 1 && changed[0] === "sum.mjs", JSON.stringify(ws?.filesChanged));

  // 主工作区必须一个字没动
  const mainStill = verifyRef(repo, "HEAD", path.join(ROOT, "check-main"));
  ok("主工作区的 HEAD 仍然是坏的(改动没漏进主线)", mainStill.ok === false, mainStill.why);
  const dirty = g(["status", "--porcelain", "--", ".", ":(exclude).graph"], repo);
  ok("主工作区干净", dirty.ok && dirty.out === "", dirty.out);
  ok("worktree 已删除", ws?.removed === true && !fs.existsSync(ws?.path || ""), ws?.path);
  const wtl = g(["worktree", "list", "--porcelain"], repo);
  ok("没有遗留 worktree 注册", (wtl.out.match(/^worktree /gm) || []).length === 1, wtl.out.slice(0, 200));

  // ── 2. 导出的 diff 必须真能用 ──────────────────────────────────────────────
  ok("diff 已导出且非空",
    !!ws?.diffPath && fs.existsSync(ws.diffPath) && fs.statSync(ws.diffPath).size > 0, ws?.diffPath);
  const applyProbe = path.join(ROOT, "apply-probe");
  const cloneOk = g(["clone", "-q", "--no-hardlinks", repo, applyProbe], ROOT).ok;
  if (cloneOk) {
    g(["checkout", "-q", ws.baseCommit], applyProbe);
    const ap = g(["apply", "--check", ws.diffPath], applyProbe);
    ok("★ 导出的 diff 能干净地 apply 回基线", ap.ok, ap.err.slice(0, 160));
  } else ok("apply 探针:克隆临时仓库", false, "clone 失败");

  // ── 3. 换引擎真复核(只传 diff 路径,不贴正文)────────────────────────────────
  const review = await withBridge((b) => b.runNode({
    id: "review", agent: REVIEW, cwd: repo, outDir,
    access: "read", timeoutMs: NODE_TIMEOUT_MS,
    prompt:
      `只读复核(**不要修改任何文件**)。有人在分支 ${ws.branch} 上修了一个 bug。\n` +
      `改动的完整 diff 在:${ws.diffPath}\n` +
      `你当前工作区是**修改前**的状态,可以直接读 sum.mjs / test.mjs 对照。\n\n` +
      `请回答:①这个改动是否真的修好了 test.mjs 覆盖的全部用例 ②有没有引入新问题\n` +
      `③结论一行,以 \`VERDICT: CORRECT\` 或 \`VERDICT: WRONG\` 结尾。`,
  }), {});
  ok("复核环节 status=ok", review.status === "ok", `${review.status} ${review.error ?? ""}`);
  const rtext = review.artifactPath && fs.existsSync(review.artifactPath)
    ? fs.readFileSync(review.artifactPath, "utf8") : "";
  ok("复核者认定改动正确", /VERDICT:\s*CORRECT/i.test(rtext), rtext.slice(-200));
  ok("复核环节没有工作区(read 档不建 worktree)", review.workspace === null && review.access === "read");

  // ── 4. 脏主树闸(真仓库上再验一次)──────────────────────────────────────────
  fs.writeFileSync(path.join(repo, "sum.mjs"), BUGGY_SUM + "// 本地未提交改动\n", "utf8");
  let refused = null;
  try {
    await withBridge((b) => b.runNode({
      id: "should-refuse", agent: IMPL, cwd: repo, outDir,
      access: "write", timeoutMs: NODE_TIMEOUT_MS, prompt: "不该跑到这里",
    }), {});
  } catch (e) { refused = e; }
  ok("真仓库上脏主树同样被拒", refused instanceof UsageError, refused?.constructor?.name);
  ok("拒绝发生在开会话之前(没白花钱)",
    !fs.existsSync(path.join(outDir, "nodes", "should-refuse.receipt.json")));

  exitCode = fail === 0 ? 0 : 1;
} catch (e) {
  ok(`夹具自己抛了:${e?.message || e}`, false);
  console.log(e?.stack || "");
} finally {
  // --keep:留下临时仓库,好让人自己进去 `git log` / 看 diff / 跑测试,而不是只能信这份输出。
  if (KEEP) {
    console.log("");
    console.log(`[keep] 临时仓库留在:${ROOT}`);
    console.log(`[keep]   cd "${path.join(ROOT, "repo")}" && git log --oneline --all && git branch -a`);
    console.log(`[keep]   看这次的改动:git show <上面那条 graph/... 分支>`);
    console.log(`[keep]   自己验一遍:git checkout <分支> && node test.mjs   # 应该打印 ALL_PASS`);
    console.log(`[keep] 看完请自行删除:rm -rf "${ROOT}"`);
  } else {
    for (let i = 0; i < 40 && fs.existsSync(ROOT); i++) {
      try { fs.rmSync(ROOT, { recursive: true, force: true }); break; }
      catch { await new Promise((r) => setTimeout(r, 250)); }
    }
  }
  console.log("");
  console.log(`>>> ${fail === 0 ? "PASS" : "FAIL"}: ${pass} 通过 / ${fail} 失败(真后端 graph-write e2e)`);
  process.exit(exitCode);
}
