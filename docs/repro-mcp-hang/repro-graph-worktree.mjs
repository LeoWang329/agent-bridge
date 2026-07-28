// Hermetic 回归:agent-bridge-graph 的 `access:"write"` worktree 隔离 + 并发闸。
// 全程 fake-omp(新增 writeturn 模式:真往 cwd 里写文件)+ 临时 git 仓库,零真实模型消耗、零网络。
//
//   node docs/repro-mcp-hang/repro-graph-worktree.mjs
//
// 断言的是**契约**:
//   W1 端到端      writeturn  → 改动落在自己分支 / 导出 diff / worktree 被删 / 回执字段齐全
//   W2 隔离        writeturn×2→ 两个环节的改动互不可见;**主工作区始终没被碰过**
//   W3 基线闸      脏主树     → 默认当场拒绝(且列出到底哪些文件看不见);allowDirtyBase 才放行
//   W4 参数闸      read 环节  → 传 baseRef/allowDirtyBase 当场 UsageError(不静默忽略)
//   W5 非 git      write      → cwd 不是仓库时人话报错
//   W6 复用闸      基线漂移   → specHash 一样但 baseCommit 变了,拒绝复用(不把过期 diff 当本次结果)
//   W7 空改动      okturn     → 不留空提交、不留垃圾分支
//   W8 并发闸      slowsettle → maxConcurrent=2 时,**同时存在的会话数**实测不超过 2
//   W10 CLI        --write    → node-turn.mjs 的 write 档;read 档传 --base-ref 要报用法错
//   W11 故障注入   writeturn-break → 收尾时 git 探测失败:**不删工作树/分支**、状态降级 unknown
//   W16 交接竞态   —          → 释放名额的那一拍,迟到的 acquire 不能插队顶穿 maxConcurrent
//   W17 重名 outDir writeturn×2→ 目录名相同但全路径不同的两次运行,分支/工作树必须各走各的
//   W18 自己提交   writeturn-commit → agent 自行 commit 后暂存区是空的,**不能**当成零改动删分支
//   W19 切走 HEAD  writeturn-detach → 交付物落点无法判定 → 保留现场、状态不是 ok
//   W20 空格路径   writeturn  → 仓库根含空格时 worktree/diff/脏树闸整条链路照样成立
//   W3b 排队变脏   writeturn  → 在闸外排队期间主树才变脏 → 拿到闸之后的第二次检查必须拦下它
//   W21 排除项     writeturn  → `outDir/nodes` 底下**被跟踪**文件的改动不能被排除项吞掉
//   W22 哑后端     deafstart  → 删树必须由「close 被确认」授权,而不是由「turn 失败」授权
//   W23 post 钩子  writeturn  → 工具自己那次提交完全不跑钩子(--no-verify 挡不住 post-commit)
//   W24 空提交     writeturn-emptycommit → 净改动为零时,首跑与复用的判据必须一致(0 字节 diff 合法)
//   W25 空格目录名 writeturn  → outDir 的 basename 含空格时分支名要被洗干净,而不是直接不可用
//   W9 零残留      —          → git worktree list 干净、.graph/wt 下没有遗留目录
//
// ⚠️ 反空绿纪律:W1/W2 不能只查"分支存在",必须 `git show` 出**内容**;W8 不能只测总耗时
//    (那会被机器快慢左右),要**实际采样并发会话数**。

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withBridge, UsageError } from "../../skills/agent-bridge-graph/tools/node-core.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_OMP = path.join(HERE, process.platform === "win32" ? "fake-omp.cmd" : "fake-omp.sh");

const RUN_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "graph-wt-"));
const STATE_DIR = path.join(RUN_ROOT, "state");
fs.mkdirSync(STATE_DIR, { recursive: true });
const BASE_ENV = { OMP_BIN: FAKE_OMP, AGENT_BRIDGE_STATE_DIR: STATE_DIR };

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 同步跑 git —— **只在测试夹具里**这么用(产品代码里是异步的,理由见 node-core 的 git())。 */
function g(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

let repoSeq = 0;
/** 造一个带一次初始提交的临时仓库。**刻意不写 .gitignore** —— 要证明产品自己排除了 `.graph/`。 */
function makeRepo(name) {
  const dir = path.join(RUN_ROOT, `repo-${++repoSeq}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  g(["init", "-q", "-b", "main"], dir);
  g(["config", "user.name", "graph-test"], dir);
  g(["config", "user.email", "graph@test.local"], dir);
  fs.writeFileSync(path.join(dir, "README.md"), "base\n", "utf8");
  g(["add", "-A"], dir);
  g(["commit", "-qm", "init"], dir);
  return dir;
}

const nodeSpec = (o) => ({ agent: "omp", timeoutMs: 60000, ...o });

const NODE_TURN = path.resolve(HERE, "../../skills/agent-bridge-graph/tools/node-turn.mjs");
/** 跑 node-turn CLI,带**硬超时**:真 hang 的时候要报失败,不能让回归自己挂住。 */
function runCli(argv, env, watchdogMs = 90000) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [NODE_TURN, ...argv],
      { env: { ...process.env, ...env }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { out += d; });
    const t = setTimeout(() => { try { c.kill("SIGKILL"); } catch {} }, watchdogMs);
    c.on("close", (code) => { clearTimeout(t); resolve({ code, out }); });
    c.on("error", (e) => { clearTimeout(t); resolve({ code: -1, out: `${out}\nspawn error: ${e.message}` }); });
  });
}

async function main() {
  // ── W1 端到端 ──────────────────────────────────────────────────────────────
  console.log("\n[W1] write 环节端到端:改动落到自己的分支上");
  const r1 = makeRepo("e2e");
  const out1 = path.join(r1, ".graph", "run-1");
  const rec1 = await withBridge((b) => b.runNode(nodeSpec({
    id: "writer", cwd: r1, outDir: out1, access: "write", prompt: "PROMPT_W1",
  })), { env: { ...BASE_ENV, FAKE_OMP_MODE: "writeturn" } });

  ok("status=ok", rec1.status === "ok", `${rec1.status} ${rec1.error ?? ""}`);
  ok("回执带 access:write", rec1.access === "write", String(rec1.access));
  const ws1 = rec1.workspace;
  ok("回执带 workspace 块", !!ws1 && ws1.mode === "worktree", JSON.stringify(ws1)?.slice(0, 120));
  ok("记了 baseCommit", /^[0-9a-f]{40}$/.test(ws1?.baseCommit || ""), ws1?.baseCommit);
  ok("提交成功", ws1?.committed === true, JSON.stringify(ws1?.filesChanged));
  ok("记了 headCommit", /^[0-9a-f]{40}$/.test(ws1?.headCommit || ""), ws1?.headCommit);
  ok("filesChanged 里有后端写的文件",
    (ws1?.filesChanged || []).some((f) => f.path === "wrote-by-node.txt"),
    JSON.stringify(ws1?.filesChanged));
  // **反空绿**:不能只看"分支在",要把内容取出来比对
  const shown = g(["show", `${ws1?.branch}:wrote-by-node.txt`], r1);
  ok("分支上确实有那个文件,且内容是本环节的 prompt",
    shown.ok && shown.out.includes("PROMPT_W1"), `${shown.out || shown.err}`.slice(0, 120));
  ok("diff 已导出且非空",
    !!ws1?.diffPath && fs.existsSync(ws1.diffPath) && fs.statSync(ws1.diffPath).size > 0, ws1?.diffPath);
  ok("diff 内容认得出是那个文件",
    fs.existsSync(ws1?.diffPath || "") && fs.readFileSync(ws1.diffPath, "utf8").includes("wrote-by-node.txt"));
  ok("worktree 已删除", ws1?.removed === true && !fs.existsSync(ws1?.path || ""), ws1?.path);
  // **主工作区绝不能被碰**
  ok("主工作区没有被写入", !fs.existsSync(path.join(r1, "wrote-by-node.txt")));
  const st1 = g(["status", "--porcelain", "--", ".", ":(exclude).graph"], r1);
  ok("主工作区仍然干净(排除我们自己的 .graph/)", st1.ok && st1.out === "", st1.out);
  const wtl1 = g(["worktree", "list", "--porcelain"], r1);
  ok("git 里没有遗留 worktree 注册", (wtl1.out.match(/^worktree /gm) || []).length === 1, wtl1.out);

  // ── W2 隔离 ────────────────────────────────────────────────────────────────
  console.log("\n[W2] 两个并发 write 环节互不可见");
  const r2 = makeRepo("iso");
  const out2 = path.join(r2, ".graph", "run-1");
  // ⚠️ 工作树在 `.graph/wt/<runKey>/<id>`,而 runKey 带 outDir 全路径的指纹后缀 ——
  // **不能写死 `.graph/wt/run-1`**(写死的话采样恒为 0,这条最关键的断言就永远"通过")。
  const wtBase2 = path.join(r2, ".graph", "wt");
  const countTrees2 = () => {
    let n = 0;
    for (const d of fs.readdirSync(wtBase2, { withFileTypes: true })) {
      if (d.isDirectory()) { try { n += fs.readdirSync(path.join(wtBase2, d.name)).length; } catch {} }
    }
    return n;
  };
  // **判别力**:只看最终分支的话,一个"串行借用主工作区、跑完再恢复"的错误实现照样能过 ——
  // 分支内容对、主树最后也干净。所以必须在**运行当中**采样,证明两棵工作树是**同时**存在的。
  let maxTrees = 0, treeSamples = 0;
  const [a, bb] = await withBridge(async (b) => {
    const poll = setInterval(() => {
      try { maxTrees = Math.max(maxTrees, countTrees2()); treeSamples++; } catch {}
    }, 40);
    try {
      return await Promise.all([
        b.runNode(nodeSpec({ id: "na", cwd: r2, outDir: out2, access: "write", prompt: "ONLY_IN_A" })),
        b.runNode(nodeSpec({ id: "nb", cwd: r2, outDir: out2, access: "write", prompt: "ONLY_IN_B" })),
      ]);
    } finally { clearInterval(poll); }
  }, { env: { ...BASE_ENV, FAKE_OMP_MODE: "writeturn", FAKE_OMP_WRITE_DELAY_MS: "1200" } });

  ok("两个环节都成功", a.status === "ok" && bb.status === "ok", `${a.status}/${bb.status}`);
  ok("采样确实跑到过(否则下一条是空的)", treeSamples > 0, `samples=${treeSamples}`);
  ok("★ 两棵工作树**同时**存在过(串行借用主树的实现过不了这条)", maxTrees >= 2, `峰值 ${maxTrees}`);
  ok("两条分支不同", a.workspace?.branch !== bb.workspace?.branch,
    `${a.workspace?.branch} vs ${bb.workspace?.branch}`);
  const sa = g(["show", `${a.workspace?.branch}:wrote-by-node.txt`], r2);
  const sb = g(["show", `${bb.workspace?.branch}:wrote-by-node.txt`], r2);
  ok("A 分支上只有 A 的内容", sa.ok && sa.out.includes("ONLY_IN_A") && !sa.out.includes("ONLY_IN_B"), sa.out.slice(0, 80));
  ok("B 分支上只有 B 的内容", sb.ok && sb.out.includes("ONLY_IN_B") && !sb.out.includes("ONLY_IN_A"), sb.out.slice(0, 80));
  ok("两条分支都基于同一个基线", a.workspace?.baseCommit === bb.workspace?.baseCommit);
  const st2 = g(["status", "--porcelain", "--", ".", ":(exclude).graph"], r2);
  ok("并发写完主工作区依然干净", st2.ok && st2.out === "", st2.out);
  ok("主工作区没有 wrote-by-node.txt", !fs.existsSync(path.join(r2, "wrote-by-node.txt")));

  // ── W3 基线闸 ──────────────────────────────────────────────────────────────
  console.log("\n[W3] 主树脏时默认拒绝,显式开关才放行");
  const r3 = makeRepo("dirty");
  const out3 = path.join(r3, ".graph", "run-1");
  fs.writeFileSync(path.join(r3, "README.md"), "base\nUNCOMMITTED\n", "utf8");
  let refused = null;
  try {
    await withBridge((b) => b.runNode(nodeSpec({
      id: "d1", cwd: r3, outDir: out3, access: "write", prompt: "x",
    })), { env: { ...BASE_ENV, FAKE_OMP_MODE: "writeturn" } });
  } catch (e) { refused = e; }
  ok("脏主树 → UsageError", refused instanceof UsageError, refused?.constructor?.name);
  ok("报错里点名了看不见的文件", /README\.md/.test(refused?.message || ""), (refused?.message || "").slice(0, 200));
  ok("报错里给了两条出路", /allowDirtyBase/.test(refused?.message || "") && /commit|stash/.test(refused?.message || ""));

  const r3b = await withBridge((b) => b.runNode(nodeSpec({
    id: "d2", cwd: r3, outDir: out3, access: "write", prompt: "DIRTY_OK", allowDirtyBase: true,
  })), { env: { ...BASE_ENV, FAKE_OMP_MODE: "writeturn" } });
  ok("allowDirtyBase:true 能跑", r3b.status === "ok", `${r3b.status} ${r3b.error ?? ""}`);
  const sd = g(["show", `${r3b.workspace?.branch}:README.md`], r3);
  ok("**如实**:节点看到的确实是 HEAD 版,不含未提交那行",
    sd.ok && !sd.out.includes("UNCOMMITTED"), sd.out.slice(0, 80));
  ok("主树那处未提交改动没被动过",
    fs.readFileSync(path.join(r3, "README.md"), "utf8").includes("UNCOMMITTED"));

  // ── W3b 排队期间才变脏 ────────────────────────────────────────────────────
  console.log("\n[W3b] 在闸外排队期间主树才变脏:拿到闸之后必须再查一次");
  // 只在排队**之前**查一次,等于拿一个几分钟前的结论给现在放行 —— 扇出时后面的环节可能等很久。
  // 删掉"拿到闸后的第二次检查",这条会变绿(所以它锁的正是那次检查)。
  const r3c = makeRepo("dirty-while-queued");
  const out3c = path.join(r3c, ".graph", "run-1");
  // ⚠️ 定序不能靠"睡一会儿就当它们都体检完了" —— 每个环节开跑前要跑两条 git(体检),
  // Windows 上起进程本身就几百毫秒。睡太短就变成**两个都被前置检查拦下**(那测的还是老那道闸),
  // 睡太长又可能等到 q1 都跑完了。这里改用可观测信号定序:
  //   ① 先只发 q1,**等到它的工作树真出现**(证明它已经过了前置检查、拿到了唯一的名额)
  //   ② 这时才发 q2,树还是干净的 → 它的前置检查必然放行,然后进闸外排队
  //   ③ 再弄脏主树 → q2 拿到名额时只有"闸后那次检查"能拦住它
  const wtBase3c = path.join(r3c, ".graph", "wt");
  const settled3c = await withBridge(async (b) => {
    const p1 = b.runNode(nodeSpec({ id: "q1", cwd: r3c, outDir: out3c, access: "write", prompt: "FIRST" }));
    for (let i = 0; i < 200 && !fs.existsSync(wtBase3c); i++) await sleep(25);
    await sleep(400); // 给 q2 的前置检查留出富余(两条 git),此刻树仍干净
    const p2 = b.runNode(nodeSpec({ id: "q2", cwd: r3c, outDir: out3c, access: "write", prompt: "SECOND" }));
    await sleep(600);
    fs.writeFileSync(path.join(r3c, "README.md"), "base\nDIRTIED_WHILE_QUEUED\n", "utf8");
    return Promise.allSettled([p1, p2]);
  }, { maxConcurrent: 1, env: { ...BASE_ENV, FAKE_OMP_MODE: "writeturn", FAKE_OMP_WRITE_DELAY_MS: "4000" } });
  // ⚠️ **不能假设"先调用的先拿到闸"** —— 两个 runNode 在 acquire 之前要做的异步活儿一样多
  // (体检 / 幂等闸都是本地 I/O),谁先抢到名额并不确定。按下标断言就是一条 flaky 断言。
  // 真正的契约与顺序无关:**恰好一个跑成、恰好一个因为脏树被拦**。
  const okCount3c = settled3c.filter((s) => s.status === "fulfilled" && s.value.status === "ok").length;
  const refused3c = settled3c.filter((s) => s.status === "rejected" && s.reason instanceof UsageError
    && /README\.md/.test(s.reason.message || ""));
  ok("反空绿:恰好有一个在变脏之前跑成了(否则下一条是空的)", okCount3c === 1,
    `成功 ${okCount3c} 个:${settled3c.map((s) => s.status === "fulfilled" ? s.value.status : "rejected").join(",")}`);
  ok("★ 排队期间变脏 → 排队的那个在拿到闸之后被拦下(理由是脏树,且点名了文件)",
    refused3c.length === 1,
    settled3c.map((s) => s.status === "rejected" ? (s.reason?.message || "").slice(0, 100) : `ok:${s.value.status}`).join(" | "));

  // ── W4 参数闸 ──────────────────────────────────────────────────────────────
  console.log("\n[W4] 只对 write 有意义的参数,出现在 read 环节上要当场拒绝");
  const r4 = makeRepo("params");
  const out4 = path.join(r4, ".graph", "run-1");
  for (const [k, v] of [["baseRef", "HEAD~1"], ["allowDirtyBase", true]]) {
    let err = null;
    try {
      await withBridge((b) => b.runNode(nodeSpec({
        id: `p-${k}`, cwd: r4, outDir: out4, access: "read", prompt: "x", [k]: v,
      })), { env: { ...BASE_ENV, FAKE_OMP_MODE: "okturn" } });
    } catch (e) { err = e; }
    ok(`read 环节传 ${k} → UsageError`, err instanceof UsageError, err?.message?.slice(0, 90));
  }
  let badAccess = null;
  try {
    await withBridge((b) => b.runNode(nodeSpec({
      id: "p-bad", cwd: r4, outDir: out4, access: "exec", prompt: "x",
    })), { env: { ...BASE_ENV, FAKE_OMP_MODE: "okturn" } });
  } catch (e) { badAccess = e; }
  ok("access 只认 read/write", badAccess instanceof UsageError, badAccess?.message?.slice(0, 80));

  // ── W5 非 git 目录 ────────────────────────────────────────────────────────
  console.log("\n[W5] cwd 不是 git 仓库时的人话报错");
  const plain = path.join(RUN_ROOT, "not-a-repo");
  fs.mkdirSync(plain, { recursive: true });
  let noRepo = null;
  try {
    await withBridge((b) => b.runNode(nodeSpec({
      id: "nr", cwd: plain, outDir: path.join(RUN_ROOT, "out-nr"), access: "write", prompt: "x",
    })), { env: { ...BASE_ENV, FAKE_OMP_MODE: "writeturn" } });
  } catch (e) { noRepo = e; }
  ok("非 git 仓库 → UsageError", noRepo instanceof UsageError, noRepo?.constructor?.name);
  ok("报错说清了为什么要仓库", /worktree|git 仓库/.test(noRepo?.message || ""), (noRepo?.message || "").slice(0, 120));

  // ── W6 复用闸:基线漂移 ────────────────────────────────────────────────────
  console.log("\n[W6] specHash 一样但基线动了 → 拒绝复用");
  const r6 = makeRepo("reuse");
  const out6 = path.join(r6, ".graph", "run-1");
  const spec6 = { id: "ru", cwd: r6, outDir: out6, access: "write", prompt: "REUSE_ME" };
  const first = await withBridge((b) => b.runNode(nodeSpec(spec6)), { env: { ...BASE_ENV, FAKE_OMP_MODE: "writeturn" } });
  ok("第一次成功", first.status === "ok", first.status);

  const again = await withBridge((b) => b.runNode(nodeSpec({ ...spec6, reuseIfSame: true })),
    { env: { ...BASE_ENV, FAKE_OMP_MODE: "writeturn" } });
  ok("基线没动 → 正常复用", again.reused === true && again.status === "ok", JSON.stringify(again.reused));

  // 主树推进一个提交:baseRef 仍是 "HEAD"(specHash 不变),但它解析到的 commit 变了
  fs.writeFileSync(path.join(r6, "moved.txt"), "moved\n", "utf8");
  g(["add", "-A"], r6);
  g(["commit", "-qm", "move base"], r6);
  let drift = null;
  try {
    await withBridge((b) => b.runNode(nodeSpec({ ...spec6, reuseIfSame: true })),
      { env: { ...BASE_ENV, FAKE_OMP_MODE: "writeturn" } });
  } catch (e) { drift = e; }
  ok("基线漂移 → 拒绝复用", drift instanceof UsageError, drift?.constructor?.name);
  ok("报错说清了是基线变了(不是别的原因)", /基线/.test(drift?.message || ""), (drift?.message || "").slice(0, 140));

  // ── W6b 复用闸:交付物本身也要校验 ─────────────────────────────────────────
  console.log("\n[W6b] write 环节的交付物是分支和 diff —— 它们没了/被换了就不许复用");
  const r6b = makeRepo("reuse2");
  const out6b = path.join(r6b, ".graph", "run-1");
  const spec6b = { id: "rb", cwd: r6b, outDir: out6b, access: "write", prompt: "DELIVERABLE" };
  const base6b = await withBridge((b) => b.runNode(nodeSpec(spec6b)), { env: { ...BASE_ENV, FAKE_OMP_MODE: "writeturn" } });
  ok("先跑一次成功", base6b.status === "ok" && base6b.workspace?.committed === true, base6b.status);

  // ① 分支被删掉:回执还在、产出 sha 还对,但"改动在分支上"这句话已经不成立了
  g(["branch", "-D", base6b.workspace.branch], r6b);
  let gone = null;
  try {
    await withBridge((b) => b.runNode(nodeSpec({ ...spec6b, reuseIfSame: true })),
      { env: { ...BASE_ENV, FAKE_OMP_MODE: "writeturn" } });
  } catch (e) { gone = e; }
  ok("分支被删 → 拒绝复用", gone instanceof UsageError, gone?.constructor?.name);
  ok("报错点名了那条分支", new RegExp(base6b.workspace.branch.replace(/\//g, "\\/")).test(gone?.message || ""),
    (gone?.message || "").slice(0, 140));

  // ② diff 文件被换过:内容指纹对不上
  const r6c = makeRepo("reuse3");
  const out6c = path.join(r6c, ".graph", "run-1");
  const spec6c = { id: "rc", cwd: r6c, outDir: out6c, access: "write", prompt: "DELIVERABLE2" };
  const base6c = await withBridge((b) => b.runNode(nodeSpec(spec6c)), { env: { ...BASE_ENV, FAKE_OMP_MODE: "writeturn" } });
  ok("回执记了 diff 的内容指纹", /^[0-9a-f]{64}$/.test(base6c.workspace?.diffSha256 || ""), base6c.workspace?.diffSha256);
  fs.appendFileSync(base6c.workspace.diffPath, "\n# 被人动过\n", "utf8");
  let tampered = null;
  try {
    await withBridge((b) => b.runNode(nodeSpec({ ...spec6c, reuseIfSame: true })),
      { env: { ...BASE_ENV, FAKE_OMP_MODE: "writeturn" } });
  } catch (e) { tampered = e; }
  ok("diff 被改过 → 拒绝复用", tampered instanceof UsageError, tampered?.constructor?.name);
  ok("报错说的是内容不一致", /不一致|被改过/.test(tampered?.message || ""), (tampered?.message || "").slice(0, 140));

  // ── W7 空改动 ─────────────────────────────────────────────────────────────
  console.log("\n[W7] 一个字都没改的 write 环节:不留空提交、不留垃圾分支");
  const r7 = makeRepo("empty");
  const out7 = path.join(r7, ".graph", "run-1");
  const r7rec = await withBridge((b) => b.runNode(nodeSpec({
    id: "noop", cwd: r7, outDir: out7, access: "write", prompt: "x",
  })), { env: { ...BASE_ENV, FAKE_OMP_MODE: "okturn" } }); // okturn 不写任何文件
  ok("环节本身仍算成功", r7rec.status === "ok", r7rec.status);
  ok("没有提交", r7rec.workspace?.committed === false);
  ok("filesChanged 为空", (r7rec.workspace?.filesChanged || []).length === 0);
  ok("分支已清掉(不留指向基线的空分支)", r7rec.workspace?.branch === null, String(r7rec.workspace?.branch));
  ok("诊断里如实说了没改动",
    (r7rec.diagnostics || []).some((d) => /没有改动任何文件/.test(d)), JSON.stringify(r7rec.diagnostics));
  const br7 = g(["branch", "--list", "graph/*"], r7);
  ok("仓库里没留下 graph/* 分支", br7.out === "", br7.out);

  // ── W8 并发闸 ─────────────────────────────────────────────────────────────
  console.log("\n[W8] maxConcurrent 是机制:实测同时存在的会话数不超过上限");
  const r8 = makeRepo("gate");
  const out8 = path.join(r8, ".graph", "run-1");
  let maxSeen = 0, samples = 0;
  const gateRun = withBridge(async (b) => {
    // 采样真实并发:桥的 status 列出的就是此刻活着的会话数 = 此刻在跑的环节数
    const poll = setInterval(async () => {
      try {
        const st = await b.callTool("agent_bridge_status", {}, 5000);
        const n = Array.isArray(st?.sessions) ? st.sessions.length : 0;
        samples++;
        if (n > maxSeen) maxSeen = n;
      } catch {}
    }, 120);
    try {
      return await Promise.all([1, 2, 3, 4, 5].map((i) => b.runNode(nodeSpec({
        id: `g${i}`, cwd: r8, outDir: out8, access: "read", prompt: `g${i}`, timeoutMs: 60000,
      }))));
    } finally { clearInterval(poll); }
  }, { env: { ...BASE_ENV, FAKE_OMP_MODE: "slowsettle" }, maxConcurrent: 2 });
  const gateRecs = await gateRun;
  ok("5 个环节全部完成", gateRecs.length === 5 && gateRecs.every((r) => r.status === "ok"),
    gateRecs.map((r) => r.status).join(","));
  ok("采样确实抓到过并发(否则本检查是空的)", samples > 0 && maxSeen > 0, `samples=${samples} max=${maxSeen}`);
  ok("同时在跑的环节从未超过 maxConcurrent=2", maxSeen <= 2, `实测峰值 ${maxSeen}`);
  ok("闸没把并发压成串行(峰值确实到过 2)", maxSeen === 2, `实测峰值 ${maxSeen}`);

  let badGate = null;
  try { await withBridge(async () => {}, { env: BASE_ENV, maxConcurrent: 0 }); }
  catch (e) { badGate = e; }
  ok("maxConcurrent=0 当场拒绝", badGate instanceof UsageError, badGate?.message?.slice(0, 80));

  // ── W10 CLI 入口 ──────────────────────────────────────────────────────────
  console.log("\n[W10] node-turn.mjs 的 --write");
  const r10 = makeRepo("cli");
  const out10 = path.join(r10, ".graph", "run-1");
  const cli = await runCli([
    "--id", "cliwrite", "--agent", "omp", "--cwd", r10, "--out-dir", out10,
    "--prompt", "CLI_WRITE", "--timeout-ms", "60000", "--write", "--json",
  ], { ...BASE_ENV, FAKE_OMP_MODE: "writeturn" });
  ok("--write 退出码 0", cli.code === 0, `code=${cli.code} ${cli.out.slice(-160)}`);
  let cliRec = null;
  try { cliRec = JSON.parse(cli.out); } catch {}
  ok("--json 吐出的回执可解析", !!cliRec, cli.out.slice(0, 120));
  ok("回执里有 workspace.branch", !!cliRec?.workspace?.branch, JSON.stringify(cliRec?.workspace)?.slice(0, 120));
  const cliShow = g(["show", `${cliRec?.workspace?.branch}:wrote-by-node.txt`], r10);
  ok("分支上是 CLI 这一轮写的内容", cliShow.ok && cliShow.out.includes("CLI_WRITE"), cliShow.out.slice(0, 80));

  // **不带 --write 时传 --base-ref**:必须是"你传了没用的参数"这句人话,而不是别的错
  const cliBad = await runCli([
    "--id", "clibad", "--agent", "omp", "--cwd", r10, "--out-dir", out10,
    "--prompt", "x", "--timeout-ms", "60000", "--base-ref", "HEAD",
  ], { ...BASE_ENV, FAKE_OMP_MODE: "okturn" });
  ok("read 档传 --base-ref → 退出码 5(用法错)", cliBad.code === 5, `code=${cliBad.code}`);
  ok("报错说清了它只在 --write 时有意义", /只在 --write 时有意义/.test(cliBad.out), cliBad.out.slice(-160));

  // ── W11 故障注入 ──────────────────────────────────────────────────────────
  console.log("\n[W11] 收工作区时 git 探测失败 → 绝不能当成「零改动」把代码删掉");
  const r11 = makeRepo("break");
  const out11 = path.join(r11, ".graph", "run-1");
  // writeturn-break:后端写完文件后把 worktree 的 .git 链接删掉 → 收尾时 git add / 列 staged 都失败。
  // 此时既不能说"有改动"也不能说"没改动";把"不知道"当成"没有"就会连代码带分支一起删。
  const rec11 = await withBridge((b) => b.runNode(nodeSpec({
    id: "broken", cwd: r11, outDir: out11, access: "write", prompt: "WORK_THAT_MUST_SURVIVE",
  })), { env: { ...BASE_ENV, FAKE_OMP_MODE: "writeturn-break" } });

  // **反空绿第一条**:注入本身必须真的发生过。注入悄悄失败(Windows 上 .git 是隐藏文件,
  // 直接覆写会 EPERM)的话,后面每一条"没删代码"都会自动成立 —— 整个 W11 变成空绿。
  const a11 = rec11.artifactPath && fs.existsSync(rec11.artifactPath)
    ? fs.readFileSync(rec11.artifactPath, "utf8") : "";
  ok("★ 故障确实注进去了(后端自报 BREAK_OK)", /BREAK_OK/.test(a11), a11.slice(0, 160));
  ok("状态降级为 unknown(不是 ok)", rec11.status === "unknown", String(rec11.status));
  ok("error 说清了交付物没能确认落到分支上,并指出工作区留在哪",
    /没能确认落到分支上/.test(rec11.error || "") && (rec11.error || "").includes(rec11.workspace?.path || " "),
    (rec11.error || "").slice(0, 160));
  ok("changesKnown=false(如实承认不知道)", rec11.workspace?.changesKnown === false, String(rec11.workspace?.changesKnown));
  ok("removed=false(没删)", rec11.workspace?.removed === false, String(rec11.workspace?.removed));
  ok("★ 工作树目录还在", fs.existsSync(rec11.workspace?.path || ""), rec11.workspace?.path);
  const survived = path.join(rec11.workspace?.path || "", "wrote-by-node.txt");
  ok("★ agent 写出来的文件还在", fs.existsSync(survived), survived);
  ok("★ 文件内容就是这一轮写的那份",
    fs.existsSync(survived) && fs.readFileSync(survived, "utf8").includes("WORK_THAT_MUST_SURVIVE"));
  ok("★ 分支没被删", g(["rev-parse", "--verify", `refs/heads/${rec11.workspace?.branch}`], r11).ok, rec11.workspace?.branch);
  ok("诊断里如实说了原样保留",
    (rec11.diagnostics || []).some((d) => /原样保留/.test(d)), JSON.stringify(rec11.diagnostics).slice(0, 200));
  // 反空绿:降级逻辑必须是**被这次故障触发的**,不是任何 write 环节都降级
  ok("反空绿:正常的 write 环节没有被降级", rec1.status === "ok" && rec1.workspace?.changesKnown === true);

  // ── W12 开会话就失败 ──────────────────────────────────────────────────────
  console.log("\n[W12] 后端起不来时不该白留一棵空工作树和一条空分支");
  const r12 = makeRepo("nostart");
  const out12 = path.join(r12, ".graph", "run-1");
  const rec12 = await withBridge((b) => b.runNode(nodeSpec({
    id: "nostart", cwd: r12, outDir: out12, access: "write", prompt: "x",
  })), { env: { ...BASE_ENV, OMP_BIN: path.join(RUN_ROOT, "no-such-omp-binary") } });
  ok("环节失败(不是假成功)", rec12.status !== "ok", rec12.status);
  ok("★ 工作树目录已清掉(压根没会话在写,没理由留)",
    !fs.existsSync(rec12.workspace?.path || ""), rec12.workspace?.path);
  // ⚠️ 分支名必须**从回执里取**,不能照着 `graph/run-1/nostart` 写死 ——
  // runKey 带指纹后缀,写死的名字压根就没存在过,那条断言会永远"通过"(假绿)。
  // ⚠️ 不能照着 `graph/run-1/nostart` 写死分支名(runKey 带指纹后缀,写死的名字压根没存在过,
  // 断言会永远"通过");也不能从回执里读 —— 清理成功时它已经被置成 null。
  // 改成扫**整个 `refs/heads/graph/`**:清干净了就一条都不该剩,清漏了必然露出来。
  const brs12 = g(["for-each-ref", "--format=%(refname)", "refs/heads/graph/"], r12);
  ok("★ 空分支也已清掉(refs/heads/graph/ 下一条不剩)",
    brs12.ok && brs12.out.trim() === "", brs12.out.slice(0, 200));
  const wtl12 = g(["worktree", "list", "--porcelain"], r12);
  ok("没有遗留 worktree 注册", (wtl12.out.match(/^worktree /gm) || []).length === 1, wtl12.out.slice(0, 160));

  // ── W13 复用闸对缺字段必须 fail-closed ────────────────────────────────────
  console.log("\n[W13] 回执缺字段 → 拒绝复用(**不能静默跳过校验**)");
  // ⚠️ 判别力:光断言"抛了 UsageError"锁不住这次的修法 —— 例如 headCommit 为 null 时,
  // 旧代码拿 `"abc" !== null` 比也会拒绝,只是理由是"分支不指向那个提交"(误导)。
  // 所以要断言**报错说的是"缺字段"**,那才是 fail-closed 这次真正加进去的东西。
  // 断言报错**点名了那个具体缺的字段** —— 比只匹配一句泛泛的"交付物是残的"更有判别力:
  // 它同时锁住了"走的是缺字段那条路"和"报的就是被抹掉的那个字段"。
  const missingPat = {
    diffSha256: /却缺字段.*diffSha256/,
    headCommit: /却缺字段.*headCommit/,
    diffPath: /却缺字段.*diffPath/,
    // 「四样齐全」里的改动清单同样要查:缺它/它不是数组,交付物一样是残的,
    // 而且下游拿它 .map/.length 会直接崩。changesKnown:false 更是自相矛盾。
    filesChanged: /却缺字段.*filesChanged/,
    changesKnown: /却缺字段.*changesKnown/,
  };
  for (const [field, label] of [["diffSha256", "diff 指纹"], ["headCommit", "headCommit"], ["diffPath", "diff 路径"],
                                ["filesChanged", "改动清单"], ["changesKnown", "changesKnown"]]) {
    const rx = makeRepo(`missing-${field}`);
    const outx = path.join(rx, ".graph", "run-1");
    const specx = { id: "mx", cwd: rx, outDir: outx, access: "write", prompt: `MISS_${field}` };
    const basex = await withBridge((b) => b.runNode(nodeSpec(specx)), { env: { ...BASE_ENV, FAKE_OMP_MODE: "writeturn" } });
    if (basex.status !== "ok") { ok(`${label}:先跑一次成功`, false, basex.status); continue; }
    // 把回执里的那个字段抹掉 —— 模拟"上次收尾时那一步没成"
    const rp = path.join(outx, "nodes", "mx.receipt.json");
    const rec = JSON.parse(fs.readFileSync(rp, "utf8"));
    rec.workspace[field] = null;
    fs.writeFileSync(rp, JSON.stringify(rec, null, 2), "utf8");
    let err = null;
    try {
      await withBridge((b) => b.runNode(nodeSpec({ ...specx, reuseIfSame: true })),
        { env: { ...BASE_ENV, FAKE_OMP_MODE: "writeturn" } });
    } catch (e) { err = e; }
    ok(`缺 ${label} → 拒绝复用`, err instanceof UsageError, `${err?.constructor?.name}:${(err?.message || "").slice(0, 90)}`);
    ok(`缺 ${label} → 报错说的是「缺字段」而不是「不匹配」`,
      missingPat[field].test(err?.message || ""), (err?.message || "").slice(0, 120));
  }

  // ── W14 脏树闸对「复用」同样生效 ──────────────────────────────────────────
  console.log("\n[W14] 同一个脏工作区:真跑会被拒,复用也必须被拒(不能两套待遇)");
  const r14 = makeRepo("dirty-reuse");
  const out14 = path.join(r14, ".graph", "run-1");
  const spec14 = { id: "dr", cwd: r14, outDir: out14, access: "write", prompt: "DIRTY_REUSE" };
  const base14 = await withBridge((b) => b.runNode(nodeSpec(spec14)), { env: { ...BASE_ENV, FAKE_OMP_MODE: "writeturn" } });
  ok("先在干净树上跑一次成功", base14.status === "ok", base14.status);
  fs.writeFileSync(path.join(r14, "README.md"), "base\nLOCAL_EDIT\n", "utf8"); // 现在把主树弄脏
  let dirtyReuse = null;
  try {
    await withBridge((b) => b.runNode(nodeSpec({ ...spec14, reuseIfSame: true })),
      { env: { ...BASE_ENV, FAKE_OMP_MODE: "writeturn" } });
  } catch (e) { dirtyReuse = e; }
  ok("★ 脏树下命中复用同样被拒", dirtyReuse instanceof UsageError, dirtyReuse?.constructor?.name);
  ok("拒的理由就是脏树(不是别的)", /未提交改动/.test(dirtyReuse?.message || ""), (dirtyReuse?.message || "").slice(0, 120));

  // ── W15 含空格的路径 ──────────────────────────────────────────────────────
  console.log("\n[W15] filesChanged 按 TAB 切,含空格的路径不能被拆坏");
  const r15 = makeRepo("spaces");
  const out15 = path.join(r15, ".graph", "run-1");
  const rec15 = await withBridge((b) => b.runNode(nodeSpec({
    id: "sp", cwd: r15, outDir: out15, access: "write", prompt: "SPACES",
  })), { env: { ...BASE_ENV, FAKE_OMP_MODE: "writeturn", FAKE_OMP_WRITE_EXTRA: "1" } });
  ok("环节成功", rec15.status === "ok", rec15.status);
  const paths15 = (rec15.workspace?.filesChanged || []).map((f) => f.path);
  ok("★ 带空格的路径原样保留", paths15.includes("a file with spaces.txt"), JSON.stringify(paths15));
  ok("status 字段没被路径污染",
    (rec15.workspace?.filesChanged || []).every((f) => /^[A-Z]\d*$/.test(f.status)),
    JSON.stringify(rec15.workspace?.filesChanged));

  // ── W16 并发闸的交接竞态 ──────────────────────────────────────────────────
  console.log("\n[W16] 名额释放的瞬间,迟到的 acquire 不能插队顶穿上限");
  // ⚠️ W8 那条(五个任务同时入队)**测不到**这个:它们在同一拍里全部排队,不存在"释放之后才到"的人。
  // 这里精确制造那一拍:占满 → 排一个等待者 → 在 release() **之前**把一个新的 acquire 塞进
  // 微任务队列(排在"唤醒队首"前面)→ 然后释放。错误实现(release 先 active--、队首醒来再 ++)
  // 在这两步之间留了个空窗,新来的看到 active<max 直接放行,队首随后再 ++ —— 同时在跑的就多一个。
  {
    const peak16 = await withBridge(async (b) => {
      const gate = b._gate;
      let live = 0, peak = 0;
      const held = [];
      const enter = async () => {
        await gate.acquire();
        live++; peak = Math.max(peak, live);
        held.push(() => { live--; gate.release(); });
      };
      await enter(); await enter();                 // 占满 max=2
      const queued = enter();                       // 队首排队中
      await sleep(0);
      const late = Promise.resolve().then(enter);   // 迟到者:微任务排在"唤醒队首"之前
      held.shift()();                               // ← 竞态窗口就在这一刻
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      const atWindow = peak;
      // 排空:交接式实现里名额不外溢,必须真放才进得来(否则这段会自己卡住)
      let guard = 0;
      while ((held.length > 0 || live > 0) && guard++ < 40) {
        if (held.length) held.shift()();
        await new Promise((r) => setImmediate(r));
      }
      await Promise.all([queued, late]);
      while (held.length) held.shift()();
      return atWindow;
    }, { maxConcurrent: 2, env: BASE_ENV });
    ok("反空绿:窗口里确实有人在跑(否则下一条是空的)", peak16 >= 2, `峰值 ${peak16}`);
    ok("★ 释放瞬间的峰值并发没顶穿 maxConcurrent=2", peak16 <= 2, `峰值 ${peak16}`);
  }

  // ── W17 重名 outDir ───────────────────────────────────────────────────────
  console.log("\n[W17] 两个不同 outDir 只是**目录名**相同,不能映射到同一棵工作树/同一条分支");
  // runKey 若只取 outDir 的 basename,`…/a/run-1` 与 `…/b/run-1` 会算出同一个 —— 于是同路径同分支。
  // 默认情况下第二个撞上"已存在"报错(还算安全),但带 force 就会删掉另一次运行正在写的树。
  const r17 = makeRepo("samebase");
  const out17a = path.join(RUN_ROOT, "w17-a", "run-1");
  const out17b = path.join(RUN_ROOT, "w17-b", "run-1");
  ok("前提:两个 outDir 的目录名确实一样", path.basename(out17a) === path.basename(out17b));
  const [ra17, rb17] = await withBridge((b) => Promise.all([
    b.runNode(nodeSpec({ id: "same", cwd: r17, outDir: out17a, access: "write", prompt: "FROM_A" })),
    b.runNode(nodeSpec({ id: "same", cwd: r17, outDir: out17b, access: "write", prompt: "FROM_B" })),
  ]), { env: { ...BASE_ENV, FAKE_OMP_MODE: "writeturn", FAKE_OMP_WRITE_DELAY_MS: "600" } });
  ok("两个环节都成功", ra17.status === "ok" && rb17.status === "ok", `${ra17.status}/${rb17.status}`);
  ok("★ 分支名不同", ra17.workspace?.branch !== rb17.workspace?.branch,
    `${ra17.workspace?.branch} vs ${rb17.workspace?.branch}`);
  ok("★ 工作树路径也不同", ra17.workspace?.path !== rb17.workspace?.path,
    `${ra17.workspace?.path} vs ${rb17.workspace?.path}`);
  const sh17a = g(["show", `${ra17.workspace?.branch}:wrote-by-node.txt`], r17);
  const sh17b = g(["show", `${rb17.workspace?.branch}:wrote-by-node.txt`], r17);
  ok("★ A 的分支上只有 A 的内容", sh17a.ok && sh17a.out.includes("FROM_A") && !sh17a.out.includes("FROM_B"), sh17a.out.slice(0, 60));
  ok("★ B 的分支上只有 B 的内容", sh17b.ok && sh17b.out.includes("FROM_B") && !sh17b.out.includes("FROM_A"), sh17b.out.slice(0, 60));

  // ── W18 agent 自己提交 ────────────────────────────────────────────────────
  console.log("\n[W18] agent 自己 git commit 过:绝不能当成「零改动」把分支删掉");
  const r18 = makeRepo("selfcommit");
  const out18 = path.join(r18, ".graph", "run-1");
  const rec18 = await withBridge((b) => b.runNode(nodeSpec({
    id: "sc", cwd: r18, outDir: out18, access: "write", prompt: "SELF_COMMIT_BODY",
  })), { env: { ...BASE_ENV, FAKE_OMP_MODE: "writeturn-commit" } });
  const body18 = rec18.artifactPath && fs.existsSync(rec18.artifactPath)
    ? fs.readFileSync(rec18.artifactPath, "utf8") : "";
  // 反空绿:注入没生效(后端其实没提交)的话,下面每条都会因为"走的是普通路径"而轻松通过。
  ok("反空绿:后端确实自己提交了", /SELFCOMMIT_OK/.test(body18), body18.slice(0, 120));
  ok("环节成功", rec18.status === "ok", `${rec18.status} ${rec18.error || ""}`);
  ok("★ 分支还在(没被当成零改动删掉)",
    !!rec18.workspace?.branch && g(["rev-parse", "--verify", `refs/heads/${rec18.workspace.branch}`], r18).ok,
    String(rec18.workspace?.branch));
  ok("★ agent 提交的内容确实在分支上",
    g(["show", `${rec18.workspace?.branch}:wrote-by-node.txt`], r18).out.includes("SELF_COMMIT_BODY"));
  ok("★ 回执如实列出了交付的改动(不是空数组)",
    (rec18.workspace?.filesChanged || []).some((f) => f.path === "wrote-by-node.txt"),
    JSON.stringify(rec18.workspace?.filesChanged));
  ok("outcome=delivered", rec18.workspace?.outcome === "delivered", String(rec18.workspace?.outcome));
  ok("★ diff 导出了且非空",
    !!rec18.workspace?.diffPath && (fs.statSync(rec18.workspace.diffPath).size > 0));
  ok("主工作区没有被碰过", !fs.existsSync(path.join(r18, "wrote-by-node.txt")));

  // ── W19 agent 把 HEAD 切走 ────────────────────────────────────────────────
  console.log("\n[W19] agent 自己切走了 HEAD:交付物在哪已无法判定 → 保留现场、不报 ok");
  const r19 = makeRepo("detach");
  const out19 = path.join(r19, ".graph", "run-1");
  const rec19 = await withBridge((b) => b.runNode(nodeSpec({
    id: "dt", cwd: r19, outDir: out19, access: "write", prompt: "DETACH_BODY",
  })), { env: { ...BASE_ENV, FAKE_OMP_MODE: "writeturn-detach" } });
  const body19 = rec19.artifactPath && fs.existsSync(rec19.artifactPath)
    ? fs.readFileSync(rec19.artifactPath, "utf8") : "";
  ok("反空绿:后端确实把 HEAD 切走了", /DETACH_OK/.test(body19), body19.slice(0, 120));
  ok("★ 状态不是 ok(不能假装交付成功)", rec19.status !== "ok", rec19.status);
  ok("★ 工作树被原样保留", !!rec19.workspace?.path && fs.existsSync(rec19.workspace.path), rec19.workspace?.path);
  ok("★ 分支没被删",
    !!rec19.workspace?.branch && g(["rev-parse", "--verify", `refs/heads/${rec19.workspace.branch}`], r19).ok,
    String(rec19.workspace?.branch));
  ok("诊断说清了 HEAD 不在本环节分支上",
    /不在本环节的分支/.test(JSON.stringify(rec19.diagnostics || [])),
    JSON.stringify(rec19.diagnostics || []).slice(0, 200));

  // ── W20 路径含空格 ────────────────────────────────────────────────────────
  console.log("\n[W20] 仓库路径里有空格(Windows 上极常见)时整条链路照样成立");
  const r20 = makeRepo("has space");
  const out20 = path.join(r20, ".graph", "run-1");
  const rec20 = await withBridge((b) => b.runNode(nodeSpec({
    id: "sp", cwd: r20, outDir: out20, access: "write", prompt: "SPACE_PATH_BODY",
  })), { env: { ...BASE_ENV, FAKE_OMP_MODE: "writeturn" } });
  ok("前提:仓库路径里确实有空格", r20.includes(" "), r20);
  ok("环节成功", rec20.status === "ok", `${rec20.status} ${rec20.error || ""}`);
  ok("★ 改动落到了分支上",
    g(["show", `${rec20.workspace?.branch}:wrote-by-node.txt`], r20).out.includes("SPACE_PATH_BODY"));
  ok("★ diff 非空且能 apply 回基线", (() => {
    const d = rec20.workspace?.diffPath;
    if (!d || fs.statSync(d).size === 0) return false;
    return g(["apply", "--check", d], r20).ok;
  })(), String(rec20.workspace?.diffPath));
  ok("★ worktree 已删干净", rec20.workspace?.removed === true && !fs.existsSync(rec20.workspace?.path || ""));
  // 脏树闸的排除项是拿 path.relative 算出来的 —— 仓库根带空格时最容易在这里出岔子
  const st20 = g(["status", "--porcelain", "--", ".", ":(exclude).graph"], r20);
  ok("主工作区依然干净", st20.ok && st20.out === "", st20.out);

  // ── W21 排除项不能吞掉被跟踪文件的改动 ────────────────────────────────────
  console.log("\n[W21] `outDir/nodes` 底下**被跟踪**文件的真实改动,绝不能被排除项吞掉");
  // 早先按目录整片排(`:(exclude)<outDir>/**`,后来收窄成 `<outDir>/nodes/**`)只是缩小了绕过范围:
  // outDir 是调用方给的任意目录,指到含源码的地方(这里模拟 `repo/sub`,真源码在 `sub/nodes/`)
  // 就能让脏树闸对真实改动视而不见 —— 一道安全闸被自己的排除项关掉。
  const r21 = makeRepo("tracked-under-nodes");
  fs.mkdirSync(path.join(r21, "sub", "nodes"), { recursive: true });
  fs.writeFileSync(path.join(r21, "sub", "nodes", "real-source.txt"), "v1\n", "utf8");
  g(["add", "-A"], r21); g(["commit", "-qm", "add real source under sub/nodes"], r21);
  // 这是**被跟踪**文件的未提交改动 —— 属于用户的改动,必须算脏
  fs.writeFileSync(path.join(r21, "sub", "nodes", "real-source.txt"), "v2-UNCOMMITTED\n", "utf8");
  const out21 = path.join(r21, "sub");   // ← nodesDir 正好压在真源码目录上
  let err21 = null;
  try {
    await withBridge((b) => b.runNode(nodeSpec({
      id: "n21", cwd: r21, outDir: out21, access: "write", prompt: "x",
    })), { env: { ...BASE_ENV, FAKE_OMP_MODE: "writeturn" } });
  } catch (e) { err21 = e; }
  ok("★ 被跟踪文件的改动仍然算脏 → 当场拒绝", err21 instanceof UsageError, err21 && err21.message.slice(0, 120));
  ok("拒绝理由点名了那个真实改动的文件",
    !!err21 && /real-source\.txt/.test(err21.message), (err21?.message || "").slice(0, 200));
  // 反面:我们自己写的未跟踪脚手架**必须**继续被排除,否则第二个 write 环节会被自己拦下
  g(["checkout", "--", "sub/nodes/real-source.txt"], r21);
  const rec21b = await withBridge((b) => b.runNode(nodeSpec({
    id: "n21b", cwd: r21, outDir: out21, access: "write", prompt: "SCAFFOLD_OK",
  })), { env: { ...BASE_ENV, FAKE_OMP_MODE: "writeturn" } });
  ok("反面:干净之后同一个 outDir 能正常跑(自己的脚手架仍被排除)", rec21b.status === "ok", `${rec21b.status} ${rec21b.error || ""}`);

  // ── W22 后端起来了却一个字不回 ────────────────────────────────────────────
  console.log("\n[W22] 后端起得来但一个字不回:超时收场,且删树必须是「关会话被确认」授权的");
  // ⚠️ 覆盖边界说清楚:实测 `open_session` **不等后端握手** —— 后端再哑,open 也照样返回 sessionId。
  //    所以这条**测不到** `openOutcome:"unknown"`(open 请求发出去了、响应却丢了)那条分支;
  //    那条分支是防御性的,目前**没有 hermetic 注入手段**,别把这条当成它的证据。
  //    这条真正锁住的是:删树必须由「close 被确认」授权,而不是由「turn 失败」授权。
  const r22 = makeRepo("deafopen");
  const out22 = path.join(r22, ".graph", "run-1");
  const rec22 = await withBridge((b) => b.runNode(nodeSpec({
    id: "deaf", cwd: r22, outDir: out22, access: "write", prompt: "x", timeoutMs: 6000,
  })), { env: { ...BASE_ENV, FAKE_OMP_MODE: "deafstart" } });
  ok("环节没有假成功", rec22.status !== "ok", rec22.status);
  ok("反空绿:后端确实起来了(拿到过 sessionId)", !!rec22.sessionId, String(rec22.sessionId));
  ok("★ 删树是「关会话被确认」授权的,不是「turn 失败」授权的",
    rec22.closeConfirmed === true && rec22.workspace?.removed === true,
    `closeConfirmed=${rec22.closeConfirmed} removed=${rec22.workspace?.removed}`);
  ok("空工作树没有留下垃圾分支", rec22.workspace?.branch === null,
    String(rec22.workspace?.branch));

  // ── W23 post-commit 钩子 ──────────────────────────────────────────────────
  console.log("\n[W23] `--no-verify` 挡不住 post-commit —— 工具自己那次提交必须完全不跑钩子");
  const r23 = makeRepo("posthook");
  const hookPath = path.join(r23, ".git", "hooks", "post-commit");
  fs.writeFileSync(hookPath, "#!/bin/sh\necho ran > hook-ran.txt\n", "utf8");
  try { fs.chmodSync(hookPath, 0o755); } catch {}
  // **反空绿**:先证明这台机器上钩子真的会跑,否则下面"钩子没跑"是自动成立的空断言。
  fs.writeFileSync(path.join(r23, "probe.txt"), "x\n", "utf8");
  g(["add", "-A"], r23); g(["commit", "-qm", "probe commit"], r23);
  const hookWorks = fs.existsSync(path.join(r23, "hook-ran.txt"));
  ok("反空绿:这台机器上 post-commit 钩子确实会跑", hookWorks);
  fs.rmSync(path.join(r23, "hook-ran.txt"), { force: true });
  g(["add", "-A"], r23); g(["commit", "-qm", "clean up probe"], r23);
  const out23 = path.join(r23, ".graph", "run-1");
  const rec23 = await withBridge((b) => b.runNode(nodeSpec({
    id: "ph", cwd: r23, outDir: out23, access: "write", prompt: "HOOK_BODY",
  })), { env: { ...BASE_ENV, FAKE_OMP_MODE: "writeturn" } });
  ok("环节成功", rec23.status === "ok", `${rec23.status} ${rec23.error || ""}`);
  ok("outcome=delivered", rec23.workspace?.outcome === "delivered", String(rec23.workspace?.outcome));
  ok("★ 钩子没有在工具自己的提交上跑(分支里没有 hook-ran.txt)",
    !g(["cat-file", "-e", `${rec23.workspace?.branch}:hook-ran.txt`], r23).ok);
  ok("★ 改动集里也没有 hook-ran.txt",
    !(rec23.workspace?.filesChanged || []).some((f) => f.path === "hook-ran.txt"),
    JSON.stringify(rec23.workspace?.filesChanged));

  // ── W24 空提交:净改动为零 ────────────────────────────────────────────────
  console.log("\n[W24] HEAD 前进但净改动为零:首跑与复用的判据必须一致");
  const r24 = makeRepo("emptycommit");
  const out24 = path.join(r24, ".graph", "run-1");
  const spec24 = { id: "ec", cwd: r24, outDir: out24, access: "write", prompt: "EMPTY" };
  const rec24 = await withBridge((b) => b.runNode(nodeSpec(spec24)),
    { env: { ...BASE_ENV, FAKE_OMP_MODE: "writeturn-emptycommit" } });
  const body24 = rec24.artifactPath && fs.existsSync(rec24.artifactPath)
    ? fs.readFileSync(rec24.artifactPath, "utf8") : "";
  ok("反空绿:后端确实建了空提交", /EMPTYCOMMIT_OK/.test(body24), body24.slice(0, 120));
  ok("环节成功", rec24.status === "ok", `${rec24.status} ${rec24.error || ""}`);
  ok("outcome=delivered(分支上有历史)", rec24.workspace?.outcome === "delivered", String(rec24.workspace?.outcome));
  ok("改动清单为空(净改动确实是零)", (rec24.workspace?.filesChanged || []).length === 0,
    JSON.stringify(rec24.workspace?.filesChanged));
  ok("导出的 diff 是 0 字节", !!rec24.workspace?.diffPath && fs.statSync(rec24.workspace.diffPath).size === 0);
  // ★ 关键:同一个结局不能"首跑成功、复用必拒"
  // 包一层:复用被拒时会抛 UsageError,不接住的话整个夹具当场死掉、后面的用例一条都跑不到 ——
  // 那是"一条断言失败"变成"整轮无结果",诊断价值差很多。
  let rec24b = null, err24b = null;
  try {
    rec24b = await withBridge((b) => b.runNode(nodeSpec({ ...spec24, reuseIfSame: true })),
      { env: { ...BASE_ENV, FAKE_OMP_MODE: "writeturn-emptycommit" } });
  } catch (e) { err24b = e; }
  ok("★ 复用同样通过(不拿 0 字节 diff 当失败)",
    !err24b && rec24b?.reused === true && rec24b?.status === "ok",
    err24b ? `被拒:${err24b.message.slice(0, 120)}` : `reused=${rec24b?.reused} status=${rec24b?.status}`);

  // ── W25 outDir 目录名含空格 ───────────────────────────────────────────────
  console.log("\n[W25] outDir 的**目录名本身**含空格:分支名要被洗干净,不能直接不可用");
  // W20 只让仓库父路径含空格,outDir basename 仍是 `run-1` —— 那是假覆盖。
  const r25 = makeRepo("spacebasename");
  const out25 = path.join(r25, ".graph", "run with space");
  // 包一层:洗 slug 那步若缺失,这里会抛"分支名 git 不认"的 UsageError —— 不接住会打死整个夹具。
  let rec25 = null, err25 = null;
  try {
    rec25 = await withBridge((b) => b.runNode(nodeSpec({
      id: "sb", cwd: r25, outDir: out25, access: "write", prompt: "SPACE_BASENAME",
    })), { env: { ...BASE_ENV, FAKE_OMP_MODE: "writeturn" } });
  } catch (e) { err25 = e; }
  ok("前提:outDir 的目录名确实含空格", path.basename(out25).includes(" "), path.basename(out25));
  ok("★ 环节成功(没有因为分支名非法而直接不可用)", !err25 && rec25?.status === "ok",
    err25 ? err25.message.slice(0, 140) : `${rec25?.status} ${rec25?.error || ""}`);
  ok("★ 分支名是 git 合法的", !!rec25?.workspace?.branch
    && g(["check-ref-format", "--branch", rec25.workspace.branch], r25).ok, String(rec25?.workspace?.branch));
  ok("改动落到了那条分支上", !!rec25?.workspace?.branch
    && g(["show", `${rec25.workspace.branch}:wrote-by-node.txt`], r25).out.includes("SPACE_BASENAME"));

  // ── W26 write 档的多轮对话:一段 = 一棵树、一条分支、提交一次 ─────────────────
  // 真理源:docs/DESIGN-graph-conversation-2026-07-28.md §10「write 一段一条分支」
  console.log("\n[W26] 一段对话 = 一棵工作树 + 一条分支,N 轮的改动全在里面");
  const r26 = makeRepo("conv-write");
  const out26 = path.join(r26, ".graph", "run-1");
  const rec26 = await withBridge((b) => b.conversation(
    { agent: "omp", id: "cv", cwd: r26, outDir: out26, access: "write" },
    async (turn) => {
      for (const k of ["alpha", "beta", "gamma"]) {
        const r = await turn({ key: k, prompt: k, timeoutMs: 60000 });
        ok(`W26 第 "${k}" 轮 ok`, r.status === "ok", `${r.status} ${r.error ?? ""}`);
      }
    },
  ), { env: { ...BASE_ENV, FAKE_OMP_MODE: "writeturn-perprompt" } });

  ok("W26 顶层 ok", rec26.status === "ok", `${rec26.status} ${rec26.error ?? ""}`);
  ok("W26 kind=conversation", rec26.kind === "conversation");
  ok("W26 三轮都在 turns 里", rec26.turns?.length === 3, String(rec26.turns?.length));
  const ws26 = rec26.workspace;
  ok("W26 outcome=delivered", ws26?.outcome === "delivered", JSON.stringify(ws26)?.slice(0, 160));
  // ★ 一段对话**只留一条分支** —— 不是 N 轮 N 条
  const br26 = g(["branch", "--list", "graph/*", "--format=%(refname:short)"], r26);
  ok("★ W26 只有一条分支", br26.out.split("\n").filter(Boolean).length === 1, br26.out);
  ok("W26 那条分支就是回执记的", br26.out.trim() === ws26?.branch, `${br26.out} vs ${ws26?.branch}`);
  // ★ 三轮的改动**全都在里面**(固定文件名的 writeturn 会互相覆盖,证不出这一条)
  for (const k of ["alpha", "beta", "gamma"]) {
    ok(`★ W26 第 "${k}" 轮的改动在分支上`,
      g(["show", `${ws26?.branch}:wrote-${k}.txt`], r26).out.includes(k));
  }
  ok("W26 filesChanged 有三项", (ws26?.filesChanged || []).length === 3, JSON.stringify(ws26?.filesChanged));
  // ★ 收尾时**提交一次**,不是每轮一次
  const cnt26 = g(["rev-list", "--count", `${ws26?.baseCommit}..${ws26?.branch}`], r26);
  ok("★ W26 只提交了一次(不是每轮一次)", cnt26.out === "1", cnt26.out);
  ok("W26 每轮各有自己的产出文件", ["alpha", "beta", "gamma"].every(
    (k) => fs.existsSync(path.join(out26, "nodes", `cv.t-${k}.md`))));
  // ⚠️ 这个仓刻意没有 .gitignore(要证明产品自己排除 `.graph/`),所以裸 `git status` 一定会
  // 看到那个未跟踪的 outDir —— 断言要按**产品同一口径**排除它,否则考的是夹具不是产品。
  const dirty26 = g(["status", "--porcelain"], r26).out.split("\n")
    .filter((l) => l.trim() && !/\.graph\//.test(l));
  ok("W26 主工作区没有 .graph/ 之外的改动", dirty26.length === 0, dirty26.join(" | ").slice(0, 200));
  ok("W26 工作树已收走", ws26?.removed === true, String(ws26?.removed));

  // ── W27 write 档对话的复用:两档共用同一套 workspace 闸 ─────────────────────
  // ⚠️ 这条不是补充覆盖率,是**结构性风险**:checkReuse 里对话与节点分了叉,
  //    对话必须**跳过**节点级的 artifactPath/sha 校验(它顶层压根没这个字段),
  //    又必须**照样过** write 那几道闸(基线没漂、分支还在、diff 没被换)。分叉写错就在这里露。
  console.log("\n[W27] write 档对话:指纹一致就复用,基线漂了/分支没了就拒");
  const runConv27 = (repo, outDir, extra = {}) => withBridge((b) => b.conversation(
    { agent: "omp", id: "cv", cwd: repo, outDir, access: "write", ...extra },
    async (turn) => {
      await turn({ key: "one", prompt: "one", timeoutMs: 60000 });
      await turn({ key: "two", prompt: "two", timeoutMs: 60000 });
    },
  ), { env: { ...BASE_ENV, FAKE_OMP_MODE: "writeturn-perprompt" } });

  const r27 = makeRepo("conv-reuse");
  const out27 = path.join(r27, ".graph", "run-1");
  const first27 = await runConv27(r27, out27);
  ok("W27 首跑 ok", first27.status === "ok", `${first27.status} ${first27.error ?? ""}`);
  const br27 = first27.workspace?.branch;

  const again27 = await runConv27(r27, out27, { reuseIfSame: true });
  ok("★ W27 同序列命中复用", again27.reused === true, JSON.stringify(again27.status));
  ok("W27 复用拿回的是历史 turns", again27.turns?.length === 2);
  ok("W27 复用没有多造第二条分支",
    g(["branch", "--list", "graph/*", "--format=%(refname:short)"], r27).out.split("\n").filter(Boolean).length === 1);

  // 基线漂了 —— specHash 里只有字符串 "HEAD",指纹管不住这件事,必须靠 baseCommit 比对拦下
  fs.writeFileSync(path.join(r27, "README.md"), "moved\n", "utf8");
  g(["add", "-A"], r27); g(["commit", "-qm", "move base"], r27);
  let drift27 = null;
  try { await runConv27(r27, out27, { reuseIfSame: true }); } catch (e) { drift27 = e; }
  ok("★ W27 基线变了 → 拒绝复用", drift27 instanceof UsageError && /基线变了/.test(drift27.message),
    String(drift27?.message).slice(0, 160));

  // 分支被删了 —— 交付物没了,只校验文字产出的 sha 会漏掉这条
  const r27b = makeRepo("conv-reuse-2");
  const out27b = path.join(r27b, ".graph", "run-1");
  const f27b = await runConv27(r27b, out27b);
  ok("W27 第二个仓首跑 ok", f27b.status === "ok");
  g(["branch", "-D", f27b.workspace?.branch], r27b);
  let gone27 = null;
  try { await runConv27(r27b, out27b, { reuseIfSame: true }); } catch (e) { gone27 = e; }
  ok("★ W27 分支被删 → 拒绝复用", gone27 instanceof UsageError && /分支/.test(gone27.message),
    String(gone27?.message).slice(0, 160));
  ok("W27 首跑那条分支名是对的", typeof br27 === "string" && br27.startsWith("graph/"), String(br27));

  // ── W28 已经开过头才失败的那一轮:key 烧掉,不还回来 ─────────────────────────
  // ⚠️ 这条是 EVENTS.md 复审顺着文档指回实现的:key 要是还回去,回调 catch 之后能用**同一个 key**
  //    再来一轮 —— 事件流里就有两条 `node:turn{turnKey}`,而第一条永远等不到自己的终态,
  //    页面按 key 建 map 会把前一条直接盖掉。(参数校验就没过的那种在 C19f,那种可以重用。)
  console.log("\n[W28] runTurn 里失败的轮:key 烧掉,必须换一个");
  const r28 = makeRepo("conv-burnkey");
  const out28 = path.join(r28, ".graph", "run-1");
  let first28 = null, retry28 = null;
  const rec28 = await withBridge((b) => b.conversation(
    { agent: "omp", id: "cv", cwd: r28, outDir: out28, access: "write" },
    async (turn) => {
      // prepare 那次脏树检查已经过了;现在把主树弄脏,让**首轮入场**的第二次检查抛
      fs.writeFileSync(path.join(r28, "dirty.txt"), "x\n", "utf8");
      try { await turn({ key: "draft", prompt: "one", timeoutMs: 60000 }); }
      catch (e) { first28 = e; }
      fs.rmSync(path.join(r28, "dirty.txt"), { force: true });   // 清理干净,想重试
      try { await turn({ key: "draft", prompt: "two", timeoutMs: 60000 }); }
      catch (e) { retry28 = e; }
      await turn({ key: "draft-2", prompt: "three", timeoutMs: 60000 });  // 换 key 才行
    },
  ), { env: { ...BASE_ENV, FAKE_OMP_MODE: "writeturn-perprompt" } });

  ok("W28 首轮因脏树被拒", first28 instanceof UsageError, String(first28?.message).slice(0, 100));
  ok("★ W28 同一个 key 重试被拒", retry28 instanceof UsageError, String(retry28?.message).slice(0, 100));
  ok("★ W28 说清了「入场失败也不还 key」", /不还回来/.test(String(retry28?.message)),
    String(retry28?.message).slice(0, 160));
  ok("★ W28 换个 key 就能继续", rec28.turns?.length === 1 && rec28.turns[0].key === "draft-2",
    JSON.stringify(rec28.turns?.map((t) => t.key)));
  ok("W28 顶层没被没跑成的那轮污染", rec28.status === "ok", `${rec28.status} ${rec28.error ?? ""}`);

  // ── W28b 零轮那句话不许归错类 ───────────────────────────────────────────────
  // 同样是「调过 turn() 但 turns[] 是空的」,可原因**不是**参数校验 —— 是开过头之后才失败。
  // 早先只在 normalizeTurn 一处记原因,于是这条路上收尾会说
  //   「每次都死在参数校验上……最后一次失败的原因是:(没记到)」—— 两句都是假话。
  // 口径必须是「最后一次**没进去**的原因」,而不是「最后一次**校验**错」。
  console.log("\n[W28b] 零轮诊断:开过头才失败的那种,不许说成参数校验、不许说没记到");
  const r28b = makeRepo("conv-zeroturn-reason");
  let err28b = null;
  try {
    await withBridge((b) => b.conversation(
      { agent: "omp", id: "cv", cwd: r28b, outDir: path.join(r28b, ".graph", "run-1"), access: "write" },
      async (turn) => {
        fs.writeFileSync(path.join(r28b, "dirty.txt"), "x\n", "utf8");
        try { await turn({ key: "draft", prompt: "one", timeoutMs: 60000 }); } catch { /* 吞掉 */ }
      },
    ), { env: { ...BASE_ENV, FAKE_OMP_MODE: "writeturn-perprompt" } });
  } catch (e) { err28b = e; }
  const m28b = String(err28b?.message ?? "");
  ok("W28b 抛的是用法错", err28b instanceof UsageError, m28b.slice(0, 80));
  ok("★ W28b 没说成「一次 turn() 都没调」", !/一次 turn\(\) 都没调/.test(m28b), m28b.slice(0, 120));
  ok("★ W28b 没归类成「死在参数校验上」", !/参数校验/.test(m28b), m28b.slice(0, 120));
  ok("★ W28b 没说「没记到」", !/没记到/.test(m28b), m28b.slice(0, 120));
  ok("★ W28b 报出了真实原因(脏树)", /改动|干净|dirty\.txt/.test(m28b), m28b.slice(0, 240));

  // ── W9 零残留 ─────────────────────────────────────────────────────────────
  console.log("\n[W9] 零残留总检");
  for (const [tag, repo] of [["W1", r1], ["W2", r2], ["W6", r6], ["W26", r26]]) {
    const list = g(["worktree", "list", "--porcelain"], repo);
    ok(`${tag} 仓库没有遗留 worktree 注册`, (list.out.match(/^worktree /gm) || []).length === 1, list.out.slice(0, 200));
    const wtDir = path.join(repo, ".graph", "wt");
    const leftovers = fs.existsSync(wtDir)
      ? fs.readdirSync(wtDir, { withFileTypes: true }).flatMap((d) =>
          d.isDirectory() ? fs.readdirSync(path.join(wtDir, d.name)) : [])
      : [];
    ok(`${tag} .graph/wt 下没有遗留工作树目录`, leftovers.length === 0, leftovers.join(","));
  }

  console.log(`\n[harness] ${pass} 通过 / ${fail} 失败`);
  console.log(fail === 0 ? "[harness] >>> PASS" : "[harness] >>> FAIL");
  return fail === 0 ? 0 : 1;
}

// 用例数涨到 150 条(含几段刻意的秒级延时:并发采样、排队期间变脏、哑后端超时),240s 已经不够用 ——
// 看门狗是用来抓"真挂住",不该在正常跑完之前先开火。
const watchdog = setTimeout(() => {
  console.log("[harness] >>> FAIL: 整体超时(480s),可能有环节挂住了");
  process.exit(1);
}, 480000);
watchdog.unref?.();

main()
  .then((code) => {
    clearTimeout(watchdog);
    try { fs.rmSync(RUN_ROOT, { recursive: true, force: true, maxRetries: 10 }); } catch {}
    process.exit(code);
  })
  .catch((e) => {
    clearTimeout(watchdog);
    console.log(`[harness] >>> FAIL: 夹具自己抛了 ${e?.stack || e}`);
    process.exit(1);
  });
