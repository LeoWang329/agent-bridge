// Hermetic 回归:agent-bridge-graph 的**多轮对话**(read 档)。
// 全程 fake-omp,零真实模型消耗、零网络,自带隔离 state dir。write 档的对话在 repro-graph-worktree.mjs。
//
//   node docs/repro-mcp-hang/repro-graph-conversation.mjs
//
// 真理源:docs/DESIGN-graph-conversation-2026-07-28.md §10
//
// ⚠️ 这里**考不了「记忆真的在」**:假后端没有记忆,让它"记住 nonce"只能靠假后端自己作弊,
//    那种绿是假的。那条断言属于真 e2e(真后端 + nonce),不在 hermetic 这套里。
//    这套考的是**工具自己的合同**:轮怎么分文件、闸怎么放、毒化拦不拦得住、状态怎么定、回放动不动缓存。
//
//   C1  两轮跑通      echoturn  → 两个独立产出、内容各自对应、一个会话、kind/turns 齐、零残留
//   C2  形状不串      —         → 对话回执没有逐轮字段;**runNode 回执没有 kind/turns/sessionReusable**
//   C3  串行闸        —         → Promise.all 两轮:第二个当场 UsageError,**且没产生第二个文件**
//   C4  毒化          slowturn  → 超时且 abort 未确认 → sessionReusable=false → 后续 turn 全拒
//   C5  最严重的一轮  —         → 第 1 轮 contract_error + 第 2 轮 ok ⇒ 顶层 contract_error(不是 ok)
//   C6  零轮          —         → 回调没调 turn():UsageError + **不写空回执** + 没开会话
//   C7  零轮 + 抛     —         → 抛的是**回调那个异常**,不是零轮的 UsageError
//   C8  回调炸        —         → 全轮 ok 但回调抛 ⇒ status=callback_error + 原异常重抛 + 不许被复用
//   C9  嵌套不自锁    —         → maxConcurrent=1,回调里跑 runNode **必须跑完**(带自己的超时)
//   C10 嵌套对话      —         → 当场 UsageError
//   C11 对话闸懒取    —         → maxConversations=1,A 停在首轮之前,B **仍能开始**
//   C12 用法错        多组合    → key 重复/非法/顶层 timeoutMs/顶层 prompt/超 maxTurns/迟到 turn()
//   C13 回放          —         → 同序列复用且**不开会话**;改 prompt/多一轮/少一轮/换产出 → 全拒
//   C14 回放不写回执  —         → endedAt / durationMs / 文件 mtime **一字未变**
//   C15 回放期回调炸  —         → 原异常重抛,**盘上那张 ok 回执逐字节不变**

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withBridge, finalizeRun, UsageError } from "../../skills/agent-bridge-graph/tools/node-core.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const FAKE_OMP = path.join(HERE, process.platform === "win32" ? "fake-omp.cmd" : "fake-omp.sh");
const IS_WIN = process.platform === "win32";

const RUN_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "graph-conv-"));
const STATE_DIR = path.join(RUN_ROOT, "state");
fs.mkdirSync(STATE_DIR, { recursive: true });
const BASE_ENV = { OMP_BIN: FAKE_OMP, AGENT_BRIDGE_STATE_DIR: STATE_DIR };

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`); }
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (IS_WIN) {
    const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8", windowsHide: true });
    return (r.stdout || "").includes(String(pid));
  }
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const env = (mode) => ({ ...BASE_ENV, FAKE_OMP_MODE: mode });
const spec = (o) => ({ agent: "omp", cwd: REPO, ...o });
const readReceipt = (outDir, id) => {
  const p = path.join(outDir, "nodes", `${id}.receipt.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
};
const readText = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null);
const out = (n) => path.join(RUN_ROOT, n);

/** 捕获期望中的 UsageError。**必须真的是 UsageError**,不能"抛了就算过"。 */
async function expectUsage(name, fn, match) {
  try { await fn(); ok(name, false, "没有抛异常"); }
  catch (e) {
    const isU = e instanceof UsageError;
    const hit = !match || (match instanceof RegExp ? match.test(e.message) : String(e.message).includes(match));
    ok(name, isU && hit, `${e?.constructor?.name}: ${String(e.message).slice(0, 220)}`);
  }
}

/** 带硬超时地等一件事 —— 真死锁时回归要**报失败**,而不是自己挂住。 */
function within(ms, p, label) {
  let timer;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`超时 ${ms}ms 未完成:${label}`)), ms); }),
  ]);
}

// ── C1 两轮跑通 ────────────────────────────────────────────────────────────────
async function c1() {
  console.log("\n[C1] 两轮跑通:每轮一个独立产出,内容各自对应,共用一个会话");
  const outDir = out("c1");
  let seenSession = null, sameSession = true;
  const r = await withBridge(async (b) => b.conversation(
    spec({ id: "conv", outDir }),
    async (turn) => {
      const r1 = await turn({ key: "draft", prompt: "AAA-first", timeoutMs: 30000 });
      ok("第 1 轮 ok", r1.status === "ok", r1.status);
      ok("第 1 轮带 sessionReusable", r1.sessionReusable === true);
      const r2 = await turn({ key: "fix", prompt: "BBB-second", timeoutMs: 30000 });
      ok("第 2 轮 ok", r2.status === "ok", r2.status);
    },
  ), { env: env("echoturn") });

  ok("回执 kind=conversation", r.kind === "conversation", String(r.kind));
  ok("顶层 status=ok", r.status === "ok", r.status);
  ok("turns 长度 2", Array.isArray(r.turns) && r.turns.length === 2, JSON.stringify(r.turns?.length));
  ok("poisonedAfter=null", r.poisonedAfter === null);
  const a1 = path.join(outDir, "nodes", "conv.t-draft.md");
  const a2 = path.join(outDir, "nodes", "conv.t-fix.md");
  ok("每轮一个独立产出文件", fs.existsSync(a1) && fs.existsSync(a2));
  // ⚠️ 这条才是"轮没串"的真判据:内容必须**各自**回显自己那一轮的 prompt
  ok("第 1 轮产出对应第 1 轮的提问", (readText(a1) || "").includes("AAA-first"), readText(a1)?.slice(0, 80));
  ok("第 2 轮产出对应第 2 轮的提问", (readText(a2) || "").includes("BBB-second"), readText(a2)?.slice(0, 80));
  ok("两轮产出内容不同(没有互相覆盖)", readText(a1) !== readText(a2));
  ok("turns[].artifactPath 指向各自的文件", r.turns[0].artifactPath === a1 && r.turns[1].artifactPath === a2);
  ok("每轮各有 turnSpecHash 且不相同",
    /^[0-9a-f]{32}$/.test(r.turns[0].turnSpecHash) && r.turns[0].turnSpecHash !== r.turns[1].turnSpecHash);
  ok("整段只有一个会话 id(记忆的前提)", typeof r.sessionId === "string" && r.sessionId.length > 0);
  ok("回执落盘", !!readReceipt(outDir, "conv"));
  ok("closeConfirmed=true", r.closeConfirmed === true);
}

// ── C2 形状不串 ────────────────────────────────────────────────────────────────
async function c2() {
  console.log("\n[C2] 两种回执的形状不许互相渗透");
  const outDir = out("c2");
  const conv = await withBridge(async (b) => b.conversation(
    spec({ id: "cv", outDir }),
    async (turn) => { await turn({ key: "only", prompt: "x", timeoutMs: 30000 }); },
  ), { env: env("okturn") });
  for (const k of ["artifactPath", "charCount", "byteCount", "artifactSha256", "reaskCount", "contextUsage", "abortConfirmed", "scene"]) {
    ok(`对话回执顶层没有逐轮字段 ${k}`, !(k in conv), JSON.stringify(conv[k]));
  }
  ok("逐轮字段在 turns[0] 里", conv.turns[0].artifactPath && typeof conv.turns[0].charCount === "number");

  const node = await withBridge(async (b) => b.runNode(
    spec({ id: "nd", outDir, prompt: "x", timeoutMs: 30000 }),
  ), { env: env("okturn") });
  // ⚠️ 新字段渗进旧形状 = 既有调用方与 reuseIfSame 的合同被改了
  for (const k of ["kind", "turns", "poisonedAfter", "sessionReusable"]) {
    ok(`runNode 回执**没有**新字段 ${k}`, !(k in node), JSON.stringify(node[k]));
  }
  ok("runNode 产出路径仍是 <id>.md(不是 .t-main.md)",
    node.artifactPath === path.join(outDir, "nodes", "nd.md"), node.artifactPath);
}

// ── C3 串行闸 ──────────────────────────────────────────────────────────────────
async function c3() {
  console.log("\n[C3] 同一段对话不许并发 turn()——判据在工具里,不是纪律");
  const outDir = out("c3");
  let second = null;
  await withBridge(async (b) => b.conversation(
    spec({ id: "cv", outDir }),
    async (turn) => {
      const [a, c] = await Promise.allSettled([
        turn({ key: "a", prompt: "AAA", timeoutMs: 30000 }),
        turn({ key: "b", prompt: "BBB", timeoutMs: 30000 }),
      ]);
      ok("第一个正常完成", a.status === "fulfilled" && a.value.status === "ok");
      second = c;
    },
  ), { env: env("echoturn") });
  ok("第二个当场被拒", second?.status === "rejected");
  ok("拒的是 UsageError", second?.reason instanceof UsageError, String(second?.reason));
  ok("说的是并发", /不能并发/.test(String(second?.reason?.message)));
  // ⚠️ 只看返回值不够:要真查盘 —— 被拒的那一轮**一个文件都不许产生**
  ok("被拒的轮没有产生任何产出文件", !fs.existsSync(path.join(outDir, "nodes", "cv.t-b.md")));
}

// ── C4 毒化 ────────────────────────────────────────────────────────────────────
async function c4() {
  // ⚠️ 判据是 **abort 有没有被确认**,不是"有没有超时"。两个分支都要钉死,否则改错一边也全绿。
  console.log("\n[C4a] 超时 + abort **未确认** → 那一轮可能还在后台跑 ⇒ 毒化,后续 turn 全拒");
  const outDirA = out("c4a");
  let rejected = null;
  const ra = await withBridge(async (b) => {
    // 桥回 `{aborted:false}` = **明说没打断**。真机上这对应 abort 请求超时/被拒的那一类,
    // 假后端没法直接造出来,所以在 RPC 边界上精确地造 —— 考的正是工具自己那条判据。
    const orig = b.callTool;
    b.callTool = (n, a, m) => (n === "agent_bridge_abort" ? Promise.resolve({ aborted: false }) : orig(n, a, m));
    return b.conversation(spec({ id: "cv", outDir: outDirA }), async (turn) => {
      const r1 = await turn({ key: "slow", prompt: "x", timeoutMs: 1200 });
      ok("第 1 轮 timeout", r1.status === "timeout", r1.status);
      ok("abort 未被确认", r1.abortConfirmed === false, String(r1.abortConfirmed));
      ok("那一轮标了不能再用", r1.sessionReusable === false, String(r1.sessionReusable));
      try { await turn({ key: "next", prompt: "y", timeoutMs: 30000 }); }
      catch (e) { rejected = e; }
    });
  }, { env: env("slowturn") });
  ok("后续 turn 被拒", rejected instanceof UsageError, String(rejected));
  ok("说清了是毒化", /不能再用了/.test(String(rejected?.message)));
  ok("poisonedAfter 指向那一轮", ra.poisonedAfter === "slow", String(ra.poisonedAfter));
  ok("顶层 status=timeout", ra.status === "timeout", ra.status);
  ok("被拒的轮没有产生任何产出文件", !fs.existsSync(path.join(outDirA, "nodes", "cv.t-next.md")));
  ok("turns 只有 1 条", ra.turns.length === 1, String(ra.turns.length));
  // 现场是**当轮**冻的,而且落在 turn-scoped 目录里
  const sc = ra.turns[0].scene;
  ok("现场按轮存(turn-scoped)", !!sc?.dir && sc.dir.endsWith("cv.t-slow.scene"), sc?.dir);

  console.log("\n[C4b] 超时但 abort **已确认** → 那一轮确实停了 ⇒ **不毒化**,还能接着聊");
  const outDirB = out("c4b");
  const rb = await withBridge(async (b) => b.conversation(
    spec({ id: "cv", outDir: outDirB }),
    async (turn) => {
      const r1 = await turn({ key: "slow", prompt: "x", timeoutMs: 1200 });
      ok("第 1 轮 timeout", r1.status === "timeout", r1.status);
      ok("abort 被确认了", r1.abortConfirmed === true, String(r1.abortConfirmed));
      ok("会话仍可用(不该被毒化)", r1.sessionReusable === true, String(r1.sessionReusable));
      const r2 = await turn({ key: "after", prompt: "y", timeoutMs: 30000 });
      ok("第 2 轮真的跑起来了", typeof r2.status === "string", r2.status);
    },
  ), { env: env("slowturn") });
  ok("没有被毒化", rb.poisonedAfter === null, String(rb.poisonedAfter));
  ok("两轮都在 turns 里", rb.turns.length === 2, String(rb.turns.length));
  ok("顶层取最严重的那轮(timeout)", rb.status === "timeout", rb.status);
}

// ── C5 顶层取最严重的一轮 ──────────────────────────────────────────────────────
async function c5() {
  console.log("\n[C5] 顶层结局取**最严重**的一轮,不是第一个、也不是最后一个");
  const outDir = out("c5");
  const r = await withBridge(async (b) => b.conversation(
    spec({ id: "cv", outDir }),
    async (turn) => {
      // okturn 的答案不是 JSON ⇒ 弱检查不过 ⇒ contract_error(后端好好的,所以还能接着聊)
      const r1 = await turn({ key: "bad", prompt: "x", timeoutMs: 30000, outputShape: { requiredKeys: ["nope"] }, reask: 0 });
      ok("第 1 轮 contract_error", r1.status === "contract_error", r1.status);
      ok("contract_error 不毒化(后端好好的)", r1.sessionReusable === true);
      const r2 = await turn({ key: "good", prompt: "y", timeoutMs: 30000 });
      ok("第 2 轮照常跑(一轮失败不吞后续)", r2.status === "ok", r2.status);
    },
  ), { env: env("okturn") });
  // 后面碰巧成了,不许把前面的失败盖掉
  ok("顶层 status=contract_error(不是 ok)", r.status === "contract_error", r.status);
  ok("两轮都在 turns 里", r.turns.length === 2);
}

// ── C6 / C7 零轮 ───────────────────────────────────────────────────────────────
async function c6() {
  console.log("\n[C6/C7] 一轮都没跑");
  const outDir = out("c6");
  await expectUsage("回调没调 turn() → UsageError",
    () => withBridge(async (b) => b.conversation(spec({ id: "cv", outDir }), async () => {}), { env: env("okturn") }),
    /一轮都没跑/);
  // **不写空回执**:一张 turns:[] 的回执会让下次的复用闸面对一个没有判据的对象
  ok("没有写下空回执", !readReceipt(outDir, "cv"));
  ok("锁文件也收干净了", !fs.existsSync(path.join(outDir, "nodes", "cv.lock")));

  const boom = new Error("回调自己炸了");
  let got = null;
  try {
    await withBridge(async (b) => b.conversation(
      spec({ id: "cv2", outDir }), async () => { throw boom; },
    ), { env: env("okturn") });
  } catch (e) { got = e; }
  // ⚠️ 零轮检查只是兜底诊断,回调已经抛出的异常才是根因 —— **兜底不许盖根因**
  ok("抛的是回调那个异常对象本身", got === boom, String(got?.message));

  // ── C6b「调过 turn() 但被吞了」≠「一轮都没调」──────────────────────────────────
  // 回调把入场用法错静默吞掉时,turns[] 同样是空的,可"编排空转"是**假话** —— 它起过,
  // 只是参数写错了。两者处置完全不同(去看那次 turn() 的参数 vs 去看编排为什么空转),
  // 所以运行时必须独立记账 turnCalls,而不是拿 turns.length 反推。
  // 这也是 EVENTS.md 事件层分 zero-turn / turn-validation 两档的唯一依据。
  console.log("\n[C6b] 回调吞掉 turn() 的用法错:不许谎报成「一轮都没调」");
  let msg = null;
  try {
    await withBridge(async (b) => b.conversation(
      spec({ id: "cv3", outDir }),
      async (turn) => {
        try { await turn({ key: "bad/key", prompt: "x", timeoutMs: 30000 }); } catch { /* 吞掉 */ }
        try { await turn({ key: "also bad", prompt: "x", timeoutMs: 30000 }); } catch { /* 再吞一次 */ }
      },
    ), { env: env("okturn") });
  } catch (e) { msg = e?.message ?? ""; }
  ok("★ 没说成「一次 turn() 都没调」", !/一次 turn\(\) 都没调/.test(msg), msg?.slice(0, 90));
  ok("★ 说出了调过几次", /调用了 2 次 turn\(\)/.test(msg), msg?.slice(0, 90));
  ok("★ 带上了最后一次的真实原因", /also bad/.test(msg), msg?.slice(0, 160));
  ok("同样不写空回执", !readReceipt(outDir, "cv3"));

  // ⚠️「开过头才失败」那条路上的同一件事在 W28b(worktree 套件):那里 turns[] 同样是空的,
  //    但原因不是参数校验 —— 收尾那句不许归错类,也不许说"没记到"。
}

// ── C8 回调炸 ──────────────────────────────────────────────────────────────────
async function c8() {
  console.log("\n[C8] 全轮 ok 但回调自己炸了");
  const outDir = out("c8");
  const boom = new Error("编排写错了");
  let got = null;
  try {
    await withBridge(async (b) => b.conversation(
      spec({ id: "cv", outDir }),
      async (turn) => { await turn({ key: "a", prompt: "x", timeoutMs: 30000 }); throw boom; },
    ), { env: env("okturn") });
  } catch (e) { got = e; }
  ok("原异常原样重抛(没被收尾诊断盖掉)", got === boom, String(got?.message));
  const r = readReceipt(outDir, "cv");
  ok("回执落盘了", !!r);
  ok("status=callback_error(绝不是 ok)", r?.status === "callback_error", r?.status);
  ok("error 里有回调异常的原文", /编排写错了/.test(String(r?.error)), String(r?.error));
  ok("那一轮自己仍记为 ok", r?.turns?.[0]?.status === "ok");
  // 一次崩掉的编排不许被缓存下来
  await expectUsage("这张回执不许被复用",
    () => withBridge(async (b) => b.conversation(
      spec({ id: "cv", outDir, reuseIfSame: true }),
      async (turn) => { await turn({ key: "a", prompt: "x", timeoutMs: 30000 }); },
    ), { env: env("okturn") }),
    /不是 ok/);
}

// ── C9 嵌套 runNode 不自锁 ─────────────────────────────────────────────────────
async function c9() {
  console.log("\n[C9] maxConcurrent=1:回调里跑一个普通节点必须跑得完(这条一旦回归就是死锁)");
  const outDir = out("c9");
  let nested = null;
  const r = await within(60000, withBridge(async (b) => b.conversation(
    spec({ id: "cv", outDir }),
    async (turn) => {
      await turn({ key: "a", prompt: "AAA", timeoutMs: 30000 });
      // 两轮之间换个引擎复审 —— 这是这功能的头号用法
      nested = await b.runNode(spec({ id: "review", outDir, prompt: "REVIEW", timeoutMs: 30000 }));
      await turn({ key: "b", prompt: "BBB", timeoutMs: 30000 });
    },
  ), { env: env("echoturn"), maxConcurrent: 1 }), "嵌套 runNode(maxConcurrent=1)").catch((e) => e);

  ok("没有死锁", !(r instanceof Error), String(r?.message));
  ok("嵌套节点跑完了", nested?.status === "ok", nested?.status);
  ok("嵌套节点的产出是它自己的", (readText(nested?.artifactPath) || "").includes("REVIEW"));
  ok("对话两轮都跑完", r?.turns?.length === 2);
  ok("对话顶层 ok", r?.status === "ok", r?.status);
}

// ── C10 嵌套对话 ───────────────────────────────────────────────────────────────
async function c10() {
  console.log("\n[C10] 嵌套 conversation 当场拒(它才会在对话闸上成环)");
  const outDir = out("c10");
  let inner = null;
  await withBridge(async (b) => b.conversation(
    spec({ id: "outer", outDir }),
    async (turn) => {
      await turn({ key: "a", prompt: "x", timeoutMs: 30000 });
      try {
        await b.conversation(spec({ id: "inner", outDir }), async (t2) => { await t2({ key: "z", prompt: "y", timeoutMs: 30000 }); });
      } catch (e) { inner = e; }
    },
  ), { env: env("okturn") });
  ok("嵌套对话被拒", inner instanceof UsageError, String(inner));
  ok("说清了会自锁", /自锁/.test(String(inner?.message)));
  ok("内层什么都没建", !readReceipt(outDir, "inner"));
}

// ── C11 对话闸懒取 ─────────────────────────────────────────────────────────────
async function c11() {
  console.log("\n[C11] maxConversations=1:A 停在首轮之前时,B 仍然进得来(闸必须懒取)");
  const outDir = out("c11");
  let release;
  const held = new Promise((r) => { release = r; });
  let bDone = false;

  const r = await within(60000, withBridge(async (b) => {
    const aP = b.conversation(spec({ id: "a", outDir }), async (turn) => {
      await held;                       // ← 一个 turn 都还没调,此时**不该**占着对话名额
      await turn({ key: "a1", prompt: "x", timeoutMs: 30000 });
    });
    const bP = b.conversation(spec({ id: "b", outDir }), async (turn) => {
      await turn({ key: "b1", prompt: "y", timeoutMs: 30000 });
    }).then((x) => { bDone = true; return x; });
    const rb = await bP;                // ← 闸若在 prepare 取,这里永远等不到
    release();
    const ra = await aP;
    return { ra, rb };
  }, { env: env("okturn"), maxConversations: 1 }), "对话闸懒取").catch((e) => e);

  ok("B 没有被 A 堵死", !(r instanceof Error), String(r?.message));
  ok("B 先跑完", bDone === true);
  ok("两段都成功", r?.ra?.status === "ok" && r?.rb?.status === "ok");
}

// ── C12 用法错 ─────────────────────────────────────────────────────────────────
async function c12() {
  console.log("\n[C12] 用法错一律当场 UsageError");
  const outDir = out("c12");
  const conv = (id, fn, e = "okturn") => withBridge(async (b) => b.conversation(spec({ id, outDir }), fn), { env: env(e) });

  await expectUsage("顶层不接受 timeoutMs",
    () => withBridge(async (b) => b.conversation(spec({ id: "x1", outDir, timeoutMs: 1000 }), async () => {}), { env: env("okturn") }),
    /不能放在 conversation 的顶层/);
  await expectUsage("顶层不接受 prompt",
    () => withBridge(async (b) => b.conversation(spec({ id: "x2", outDir, prompt: "p" }), async () => {}), { env: env("okturn") }),
    /不能放在 conversation 的顶层/);
  await expectUsage("key 重复",
    () => conv("x3", async (turn) => {
      await turn({ key: "same", prompt: "a", timeoutMs: 30000 });
      await turn({ key: "same", prompt: "b", timeoutMs: 30000 });
    }), /key 重复/);
  await expectUsage("key 非法字符",
    () => conv("x4", async (turn) => { await turn({ key: "bad/key", prompt: "a", timeoutMs: 30000 }); }),
    /key 只能用/);
  await expectUsage("turn 少了 timeoutMs",
    () => conv("x5", async (turn) => { await turn({ key: "k", prompt: "a" }); }), /timeoutMs 必须是正数/);
  await expectUsage("turn 的 prompt 与 promptFile 二选一",
    () => conv("x6", async (turn) => { await turn({ key: "k", timeoutMs: 30000 }); }), /二选一/);
  await expectUsage("schema 只有 codex 能用",
    () => conv("x7", async (turn) => { await turn({ key: "k", prompt: "a", timeoutMs: 30000, schema: {} }); }),
    /只有 codex 支持/);

  // fn 返回之后迟到的 turn()
  let late = null;
  await conv("x8", async (turn) => {
    await turn({ key: "k", prompt: "a", timeoutMs: 30000 });
    setTimeout(() => { turn({ key: "late", prompt: "b", timeoutMs: 30000 }).catch((e) => { late = e; }); }, 0);
  });
  await new Promise((r) => setTimeout(r, 200));
  ok("fn 返回后迟到的 turn() 被拒", late instanceof UsageError, String(late));
  ok("迟到的那轮没有产生任何文件", !fs.existsSync(path.join(outDir, "nodes", "x8.t-late.md")));

  // 超 maxTurns —— 用 21 轮,第 21 次必须响亮报错而不是静默截断
  let over = null;
  await conv("x9", async (turn) => {
    for (let i = 0; i < 21; i++) {
      try { await turn({ key: `k${i}`, prompt: "a", timeoutMs: 30000 }); }
      catch (e) { over = e; break; }
    }
  });
  ok("超过 maxTurns 响亮报错", over instanceof UsageError, String(over));
  ok("说的是 20 轮上限", /最多 20 轮/.test(String(over?.message)));
}

// ── C13/C14/C15 回放 ───────────────────────────────────────────────────────────
const SEQ = [
  { key: "one", prompt: "ONE", timeoutMs: 30000 },
  { key: "two", prompt: "TWO", timeoutMs: 30000 },
];
const runSeq = (outDir, id, seq, extra = {}) => withBridge(async (b) => b.conversation(
  spec({ id, outDir, ...extra }),
  async (turn) => { for (const t of seq) await turn({ ...t }); },
), { env: env("echoturn") });

async function c13() {
  console.log("\n[C13/C14/C15] 回放校验");
  const outDir = out("c13");
  const first = await runSeq(outDir, "cv", SEQ);
  ok("首跑成功", first.status === "ok", first.status);

  const rp = path.join(outDir, "nodes", "cv.receipt.json");
  const before = { text: fs.readFileSync(rp, "utf8"), mtime: fs.statSync(rp).mtimeMs };

  // 同序列 → 复用,且**一个会话都不开**
  let opened = 0;
  const reused = await withBridge(async (b) => {
    const orig = b.callTool;
    b.callTool = (name, args, ms) => { if (name === "agent_bridge_open_session") opened++; return orig(name, args, ms); };
    return b.conversation(spec({ id: "cv", outDir, reuseIfSame: true }),
      async (turn) => { for (const t of SEQ) await turn({ ...t }); });
  }, { env: env("echoturn") });
  ok("命中复用", reused.reused === true);
  ok("回放期间没有开过任何会话", opened === 0, String(opened));
  ok("拿回的是历史结果", reused.turns.length === 2 && reused.turns[0].key === "one");

  // 回放**不许动 canonical 回执**
  const after = { text: fs.readFileSync(rp, "utf8"), mtime: fs.statSync(rp).mtimeMs };
  ok("回执内容一字未变", after.text === before.text);
  ok("回执 mtime 未变(压根没重写)", after.mtime === before.mtime);

  // 各种不匹配 → 全拒,且**不偷偷转 live 重跑**
  const cases = [
    ["改第 1 轮 prompt → 拒整段", [{ ...SEQ[0], prompt: "CHANGED" }, SEQ[1]]],
    ["改第 2 轮 prompt → 拒整段", [SEQ[0], { ...SEQ[1], prompt: "CHANGED" }]],
    ["改 timeoutMs → 拒", [{ ...SEQ[0], timeoutMs: 31000 }, SEQ[1]]],
    ["少一轮 → 拒", [SEQ[0]]],
    ["多一轮 → 拒", [...SEQ, { key: "three", prompt: "THREE", timeoutMs: 30000 }]],
    ["换了 key → 拒", [{ ...SEQ[0], key: "uno" }, SEQ[1]]],
  ];
  for (const [name, seq] of cases) {
    let o = 0;
    await expectUsage(name, () => withBridge(async (b) => {
      const orig = b.callTool;
      b.callTool = (n, a, m) => { if (n === "agent_bridge_open_session") o++; return orig(n, a, m); };
      return b.conversation(spec({ id: "cv", outDir, reuseIfSame: true }),
        async (turn) => { for (const t of seq) await turn({ ...t }); });
    }, { env: env("echoturn") }));
    ok(`  ↳ 拒之后没有偷偷转 live(没开会话)`, o === 0, String(o));
  }

  // 产出被换过 → 当场拒
  const a2 = path.join(outDir, "nodes", "cv.t-two.md");
  const keep = fs.readFileSync(a2);
  fs.writeFileSync(a2, "TAMPERED");
  await expectUsage("某一轮的产出被换过 → 拒", () => runSeq(outDir, "cv", SEQ, { reuseIfSame: true }), /内容与回执记录的不一致/);
  fs.writeFileSync(a2, keep);

  // C15:回放期回调抛异常,**不许毁掉那张 ok 回执**
  const boom = new Error("回放期编排炸了");
  let got = null;
  try {
    await withBridge(async (b) => b.conversation(
      spec({ id: "cv", outDir, reuseIfSame: true }),
      async (turn) => { for (const t of SEQ) await turn({ ...t }); throw boom; },
    ), { env: env("echoturn") });
  } catch (e) { got = e; }
  ok("回放期回调异常被原样重抛", got === boom, String(got?.message));
  const final = fs.readFileSync(rp, "utf8");
  ok("那张 ok 回执逐字节没变(没被改写成 callback_error)", final === before.text);
  ok("它仍然是 ok", JSON.parse(final).status === "ok");
}

// ── C17 兄弟对话 ≠ 嵌套对话 ────────────────────────────────────────────────────
async function c17() {
  // ⚠️ C11 里两段对话是**同时**起的,那时 A 还停在 prepare、标记还没置上 —— 它是靠时序侥幸绿的。
  //    这里让 A **确定已经进到回调里**再起 B:嵌套判据若是个桥级布尔,B 必被误判成"嵌套"。
  console.log("\n[C17] A 已经在回调里时再起一段兄弟对话 —— 必须允许(它不是嵌套)");
  const outDir = out("c17");
  let inA;
  const enteredA = new Promise((r) => { inA = r; });
  let releaseA;
  const holdA = new Promise((r) => { releaseA = r; });

  const r = await within(60000, withBridge(async (b) => {
    const aP = b.conversation(spec({ id: "a", outDir }), async (turn) => {
      await turn({ key: "a1", prompt: "x", timeoutMs: 30000 });
      inA();            // ← 此刻 A 确确实实在回调中间
      await holdA;
      await turn({ key: "a2", prompt: "y", timeoutMs: 30000 });
    });
    await enteredA;
    // 平级的另一段对话:它**不在** A 的回调里,不该被当成嵌套
    const rb = await b.conversation(spec({ id: "b", outDir }),
      async (turn) => { await turn({ key: "b1", prompt: "z", timeoutMs: 30000 }); });
    releaseA();
    return { ra: await aP, rb };
  }, { env: env("okturn"), maxConversations: 4 }), "兄弟对话").catch((e) => e);

  ok("★ 兄弟对话没有被误判成嵌套", !(r instanceof Error), String(r?.message).slice(0, 200));
  ok("两段都成功", r?.ra?.status === "ok" && r?.rb?.status === "ok");

  // 反面:真嵌套仍然要拒 —— 别为了放行兄弟对话把嵌套一起放了
  console.log("\n[C17b] 真嵌套仍然必须拒");
  let inner = null;
  await withBridge(async (b) => b.conversation(spec({ id: "o", outDir }), async (turn) => {
    await turn({ key: "k", prompt: "x", timeoutMs: 30000 });
    try {
      await b.conversation(spec({ id: "i", outDir }),
        async (t2) => { await t2({ key: "z", prompt: "y", timeoutMs: 30000 }); });
    } catch (e) { inner = e; }
  }), { env: env("okturn") });
  ok("真嵌套仍被拒", inner instanceof UsageError, String(inner));
}

// ── C18 两条**抽取时被改掉**的合同(复审抓到的) ─────────────────────────────────
async function c18() {
  console.log("\n[C18] open_session 必须要 return_mode:\"ref\"");
  // ⚠️ 这条曾经在重构里丢过:漏了它,桥就按 full 把**整段正文塞进 JSON-RPC 响应**。
  //    假后端的产出都很小,所以 200 多条断言全绿也照样发现不了 —— 只能直接查调用参数。
  let openArgs = null;
  await withBridge(async (b) => {
    const orig = b.callTool;
    b.callTool = (n, a, m) => { if (n === "agent_bridge_open_session") openArgs = a; return orig(n, a, m); };
    return b.conversation(spec({ id: "cv", outDir: out("c18") }),
      async (turn) => { await turn({ key: "a", prompt: "x", timeoutMs: 30000 }); });
  }, { env: env("okturn") });
  ok("★ 开会话时要了 ref 模式(正文走 textRef,不塞进管道)", openArgs?.return_mode === "ref", JSON.stringify(openArgs));

  console.log("\n[C18b] finalizeRun 收尾自己出错时:**不抛异常,仍然落一张 unknown 回执**");
  // 旧版所有 finish() 都在那个大 catch 里,收尾抛错会被接住再落一张回执。抽取之后 finalize
  // 跑在 catch 外面 —— 不补一层就变成"抛异常 + 没有回执"。这里直接考 finalizeRun 的合同。
  const dir = out("c18b");
  fs.mkdirSync(path.join(dir, "nodes"), { recursive: true });
  const rp = path.join(dir, "nodes", "x.receipt.json");
  const fakeRun = {
    isConv: false,
    spec: { id: "x", access: "read" },
    receipt: { status: "ok", diagnostics: [], error: null },
    receiptPath: rp,
    workspace: null, workspaceFinalized: false,
    nodeT0: 0, t0: 0,
    closeSession: async () => { throw new Error("收尾炸了"); },
  };
  let thrown = null, rec = null;
  try { rec = await finalizeRun(fakeRun); } catch (e) { thrown = e; }
  ok("★ 收尾出错不抛异常(只有用法错才抛)", thrown === null, String(thrown?.message));
  ok("★ 仍然落了回执", fs.existsSync(rp));
  ok("状态降成 unknown(不诱导重跑)", rec?.status === "unknown", rec?.status);
  ok("原始结局没丢", /原始结局=ok/.test(String(rec?.error)), String(rec?.error));
}

// ── C19 复审第二轮抓到的四条 ───────────────────────────────────────────────────
async function c19() {
  console.log("\n[C19a] promptFile 冻结:算指纹的字节 = 发出去的字节");
  // ⚠️ 不冻的话有一条**确定性**的错误复用:指纹按 A 算好,发的是路径,桥要几个 await 之后才读;
  //    中间把文件改成 B、跑完再改回 A ⇒ 回执是「指纹 H(A) + B 的答案」,下次拿 A 来复用就命中。
  const outDir = out("c19a");
  const pf = path.join(RUN_ROOT, "prompt-toctou.txt");
  fs.writeFileSync(pf, "AAA-original", "utf8");
  const r = await withBridge(async (b) => b.conversation(spec({ id: "cv", outDir }), async (turn) => {
    const p = turn({ key: "k", promptFile: pf, timeoutMs: 30000 });  // ← 指纹此刻按 AAA 算好
    fs.writeFileSync(pf, "BBB-swapped", "utf8");                     // ← 趁它还在拿闸,把内容换掉
    await p;
  }), { env: env("echoturn") });
  const body = readText(path.join(outDir, "nodes", "cv.t-k.md")) || "";
  ok("★ 发出去的是算指纹时那份内容(不是被换掉的)", body.includes("AAA-original"), body.slice(0, 90));
  ok("★ 没有把换掉的内容发出去", !body.includes("BBB-swapped"));
  ok("那一轮仍然成功", r.turns[0].status === "ok", r.turns[0].status);
  fs.writeFileSync(pf, "AAA-original", "utf8");

  console.log("\n[C19b] 回调 `throw null`:判据是**抛没抛**,不是抛出来的东西真不真");
  const outB = out("c19b");
  let gotB = "NOTHROWN";
  try {
    await withBridge(async (b) => b.conversation(spec({ id: "cv", outDir: outB }),
      async (turn) => { await turn({ key: "a", prompt: "x", timeoutMs: 30000 }); throw null; }),
      { env: env("okturn") });
  } catch (e) { gotB = e; }
  ok("抛出来的仍是 null 本身", gotB === null, String(gotB));
  const rb = readReceipt(outB, "cv");
  ok("★ 回执不是 ok(falsy 异常也是异常)", rb?.status === "callback_error", rb?.status);
  await expectUsage("★ 这张回执不许被复用",
    () => withBridge(async (b) => b.conversation(spec({ id: "cv", outDir: outB, reuseIfSame: true }),
      async (turn) => { await turn({ key: "a", prompt: "x", timeoutMs: 30000 }); }), { env: env("okturn") }),
    /不是 ok/);

  console.log("\n[C19c] 回调抛一个**没有 toString** 的东西:不许在收尾途中被二次异常打断");
  const outC = out("c19c");
  const weird = Object.create(null);
  let gotC = null;
  try {
    await withBridge(async (b) => b.conversation(spec({ id: "cv", outDir: outC }),
      async (turn) => { await turn({ key: "a", prompt: "x", timeoutMs: 30000 }); throw weird; }),
      { env: env("okturn") });
  } catch (e) { gotC = e; }
  ok("原样抛回那个东西", gotC === weird);
  const rc = readReceipt(outC, "cv");
  ok("★ 收尾照样走完并落了回执", !!rc);
  ok("★ 会话确实关掉了(没被二次异常拦腰打断)", rc?.closeConfirmed === true, String(rc?.closeConfirmed));
  ok("状态是 callback_error", rc?.status === "callback_error", rc?.status);

  console.log("\n[C19d] 回调忘了 await 还连发两次:不许把进程打死,也不许留幽灵轮");
  const outD = out("c19d");
  const rd = await withBridge(async (b) => b.conversation(spec({ id: "cv", outDir: outD }),
    async (turn) => {
      turn({ key: "a", prompt: "AAA", timeoutMs: 30000 });   // ← 故意不 await
      turn({ key: "b", prompt: "BBB", timeoutMs: 30000 });   // ← 会被串行闸拒,且没人接这个 rejection
    }), { env: env("echoturn") });
  ok("★ 进程还活着(rejection 被认领过)", true);
  ok("★ 忘了 await 的那一轮仍被排空并记下来", rd.turns.length === 1 && rd.turns[0].key === "a", JSON.stringify(rd.turns?.map(t => t.key)));
  ok("被拒的那轮没留下文件", !fs.existsSync(path.join(outD, "nodes", "cv.t-b.md")));
  ok("回执落盘", !!readReceipt(outD, "cv"));

  console.log("\n[C19e] 入场时抛用法错的轮:不许在 turns[] 里留一条幽灵");
  // 造法:key 合法但 promptFile 不存在 —— normalizeTurn 抛在建记录之前;
  // 再造一条真进了 liveTurn 才抛的(重复 key 走不到那里,所以用 maxTurns 之外的路径),
  // 这里用 promptFile 不存在已足够证明"抛了就不该留记录"。
  const outE = out("c19e");
  let e1 = null;
  const re = await withBridge(async (b) => b.conversation(spec({ id: "cv", outDir: outE }), async (turn) => {
    await turn({ key: "good", prompt: "x", timeoutMs: 30000 });
    try { await turn({ key: "bad", promptFile: path.join(RUN_ROOT, "nope.txt"), timeoutMs: 30000 }); }
    catch (e) { e1 = e; }
  }), { env: env("okturn") });
  ok("抛了 UsageError", e1 instanceof UsageError, String(e1?.message).slice(0, 120));
  ok("★ turns[] 里只有真跑过的那一轮", re.turns.length === 1 && re.turns[0].key === "good",
    JSON.stringify(re.turns?.map(t => t.key)));
  ok("★ 顶层结局没被幽灵轮污染成 unknown", re.status === "ok", re.status);

  console.log("\n[C19f] 校验就没过的那一轮:什么都没发生过,**同一个 key 可以再来**");
  // ⚠️ 这里要和「已经开过头才失败」分清楚(那条在 W28):
  //    normalizeTurn 抛 = 参数就不合法,key 还没登记、事件流里一个字都没有 ⇒ 重用 key 完全正当。
  //    runTurn 抛   = 这一轮已经开过头(node:turn 发出去了)⇒ key 必须烧掉,不然事件流里
  //                    会有两条同 key 的开始事件、第一条永远等不到终态。
  const outF = out("c19f");
  const rf = await withBridge(async (b) => b.conversation(spec({ id: "cv", outDir: outF }), async (turn) => {
    try { await turn({ key: "draft", promptFile: path.join(RUN_ROOT, "nope.txt"), timeoutMs: 30000 }); }
    catch { /* 参数写错了,改对再来 */ }
    await turn({ key: "draft", prompt: "fixed", timeoutMs: 30000 });
  }), { env: env("echoturn") });
  ok("★ 校验没过之后,同一个 key 能接着用", rf.turns.length === 1 && rf.turns[0].key === "draft",
    JSON.stringify(rf.turns?.map(t => t.key)));
  ok("跑的是改对之后那份提问", (readText(path.join(outF, "nodes", "cv.t-draft.md")) || "").includes("fixed"));
}

// ── 零残留 ─────────────────────────────────────────────────────────────────────
async function c16() {
  console.log("\n[C16] 零残留:跑完之后桥和后端都得死");
  let pid = null;
  await withBridge(async (b) => {
    pid = b.pid;
    return b.conversation(spec({ id: "cv", outDir: out("c16") }),
      async (turn) => { await turn({ key: "a", prompt: "x", timeoutMs: 30000 }); });
  }, { env: env("okturn") });
  await new Promise((r) => setTimeout(r, 600));
  ok("桥进程已死", !isAlive(pid), `pid=${pid}`);
}

(async () => {
  console.log(`[harness] 临时根目录:${RUN_ROOT}`);
  try {
    await c1(); await c2(); await c3(); await c4(); await c5();
    await c6(); await c8(); await c9(); await c10(); await c11();
    await c12(); await c13(); await c17(); await c18(); await c19(); await c16();
  } catch (e) {
    fail++;
    console.log(`\n[harness] 用例自身崩了:${e?.stack || e}`);
  }
  console.log(`\n[harness] ${pass} 通过 / ${fail} 失败`);
  try { fs.rmSync(RUN_ROOT, { recursive: true, force: true }); } catch {}
  console.log(fail === 0 ? "[harness] >>> PASS" : "[harness] >>> FAIL");
  process.exit(fail === 0 ? 0 : 1);
})();
