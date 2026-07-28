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
import { withBridge, UsageError } from "../../skills/agent-bridge-graph/tools/node-core.mjs";

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
    await c12(); await c13(); await c16();
  } catch (e) {
    fail++;
    console.log(`\n[harness] 用例自身崩了:${e?.stack || e}`);
  }
  console.log(`\n[harness] ${pass} 通过 / ${fail} 失败`);
  try { fs.rmSync(RUN_ROOT, { recursive: true, force: true }); } catch {}
  console.log(fail === 0 ? "[harness] >>> PASS" : "[harness] >>> FAIL");
  process.exit(fail === 0 ? 0 : 1);
})();
