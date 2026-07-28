// Hermetic 回归:viz **开着**时的事件流与归档(施工清单 #8~#12)。
// 全程 fake-omp,零真实模型消耗、零网络。
//
//   node docs/repro-mcp-hang/repro-graph-viz.mjs
//
// 这份测试证的是 EVENTS.md 那几条**不变式**,不是"有没有发事件":
//   V1 单节点        —— 13 种事件的顺序 / 归档布局 / **单轮不是特例是 N=1**(turns/main/ 照样有)
//   V2 对话三轮      —— 轮这一层完整;每轮各自归档;attempt 的 n 在每轮内从 1 重开
//   V3 打回重说      —— 两条 attempt-settled,第 1 条 rejected 带原因、第 2 条各自独立产出
//   V4 撞 id         —— node:rejected{phase:"lock"},**且没有 node:settled**(不许数两次)
//   V5 跨 outDir     —— 当场拒 + **外来目录零文件**
//   V6 复用命中      —— execution:"reused" + **一条 node:turn 都不发** + 推断边仍在
//   V7 零轮两档      —— zero-turn 与 turn-validation **必须分得开**
//   V8 数据面        —— SSE 线格式(含 tx 逐字节透传)/ /file 的四道闸(400/403/404/405 分得开)
//   V9 强杀路径      —— 没有 run:final 时,管道 EOF 必须变成 control{owner-ended};健康路径不发
//
// 每个场景跑完都过一遍**全局不变式**:seq 与 nodeSeq 稠密 / 每节点恰好一个终态 /
// turn↔turn-settled 一一对应 / run:final 恒等式且是最后一条 / id 只在 observed /
// turnKey 恰好在六种事件上。

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withBridge, UsageError } from "../../skills/agent-bridge-graph/tools/node-core.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const FAKE_OMP = path.join(HERE, process.platform === "win32" ? "fake-omp.cmd" : "fake-omp.sh");
const RUN_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "graph-viz-"));
const STATE_DIR = path.join(RUN_ROOT, "state");
fs.mkdirSync(STATE_DIR, { recursive: true });

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`); }
}

let n = 0;
const freshOut = () => { const p = path.join(RUN_ROOT, `out${++n}`); fs.mkdirSync(p, { recursive: true }); return p; };

function envFor(mode) {
  const prev = { OMP_BIN: process.env.OMP_BIN, FAKE_OMP_MODE: process.env.FAKE_OMP_MODE, AGENT_BRIDGE_STATE_DIR: process.env.AGENT_BRIDGE_STATE_DIR };
  process.env.OMP_BIN = FAKE_OMP;
  process.env.FAKE_OMP_MODE = mode;
  process.env.AGENT_BRIDGE_STATE_DIR = STATE_DIR;
  return () => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
}

/** 读出一份 transcript(只会有一份 —— 一个 withBridge 一个 graph)。 */
function readTranscript(outDir) {
  const runsRoot = path.join(outDir, "nodes", ".runs");
  const ids = fs.existsSync(runsRoot) ? fs.readdirSync(runsRoot) : [];
  if (ids.length !== 1) return { graphId: null, lines: [], runsRoot, ids };
  const f = path.join(runsRoot, ids[0], "transcript.jsonl");
  const raw = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
  const lines = raw.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
  return { graphId: ids[0], lines, runsRoot, dir: path.join(runsRoot, ids[0]) };
}
const evs = (lines, type) => lines.filter((l) => l.event === type);
const has = (outDir, rel) => fs.existsSync(path.join(outDir, rel));

/** 全局不变式 —— 每个场景跑完都过一遍。 */
function checkInvariants(tag, outDir, { expectFinal = true } = {}) {
  const { lines, graphId } = readTranscript(outDir);
  ok(`${tag} 有且只有一份 transcript`, graphId !== null);
  if (!graphId) return { lines: [] };

  // seq 从 0 起、稠密 —— 空洞 = 记录损坏(白送的自查不变式)
  const seqs = lines.map((l) => l.seq);
  ok(`${tag} seq 从 0 起且稠密`, seqs.every((s, i) => s === i), `拿到 ${seqs.slice(0, 12).join(",")}…`);
  ok(`${tag} 每条都带同一个 graphId`, lines.every((l) => l.graphId === graphId));
  ok(`${tag} v 恒为 1`, lines.every((l) => l.v === 1));

  // run:started 恰好一条,且 seq === 0
  const started = evs(lines, "run:started");
  ok(`${tag} run:started 恰好一条且 seq===0`, started.length === 1 && started[0].seq === 0);

  if (expectFinal) {
    const final = evs(lines, "run:final");
    ok(`${tag} run:final 恰好一条`, final.length === 1);
    ok(`${tag} run:final 是**最后一条**`, final.length === 1 && final[0].seq === lines[lines.length - 1].seq);
    if (final.length === 1) {
      const c = final[0].payload.counts;
      // ★ 恒等式:每个已 observed 的节点恰好有一个终态事件
      const sum = c.rejected + c.ok + c.contract_error + c.backend_failed + c.timeout + c.unknown + c.callback_error;
      ok(`${tag} ★ 恒等式 observed === rejected+六档`, c.observed === sum, `${c.observed} ≠ ${sum} — ${JSON.stringify(c)}`);
      ok(`${tag} counts 九个键全在`,
        ["observed", "rejected", "ok", "contract_error", "backend_failed", "timeout", "unknown", "callback_error", "reused"]
          .every((k) => Number.isSafeInteger(c[k])));
      ok(`${tag} reused ≤ ok(它是子集不是并列的桶)`, c.reused <= c.ok);
      // 实际事件条数要与 counts 对得上 —— 否则 counts 是自说自话
      ok(`${tag} counts.observed 与实际 node:observed 条数一致`,
        c.observed === evs(lines, "node:observed").length);
      ok(`${tag} counts.rejected 与实际 node:rejected 条数一致`,
        c.rejected === evs(lines, "node:rejected").length);
    }
  }

  // ★ 每个节点恰好一个终态(rejected 与 settled 二选一,不许都有、不许都没有)
  const perNode = new Map();
  for (const l of lines) {
    const ns = l.payload?.nodeSeq;
    if (ns === undefined) continue;
    if (!perNode.has(ns)) perNode.set(ns, { rejected: 0, settled: 0, observed: 0, turn: new Map() });
    const e = perNode.get(ns);
    if (l.event === "node:rejected") e.rejected++;
    if (l.event === "node:settled") e.settled++;
    if (l.event === "node:observed") e.observed++;
    if (l.event === "node:turn" || l.event === "node:turn-settled") {
      const k = l.payload.turnKey;
      if (!e.turn.has(k)) e.turn.set(k, { open: 0, close: 0 });
      if (l.event === "node:turn") e.turn.get(k).open++; else e.turn.get(k).close++;
    }
  }
  const badTerm = [...perNode.entries()].filter(([, e]) => e.rejected + e.settled !== 1);
  ok(`${tag} ★ 每个节点恰好一个终态`, badTerm.length === 0,
    badTerm.map(([ns, e]) => `#${ns}: rejected=${e.rejected} settled=${e.settled}`).join("; "));
  const badObs = [...perNode.entries()].filter(([, e]) => e.observed !== 1);
  ok(`${tag} 每个节点恰好一条 node:observed`, badObs.length === 0);

  // ★ node:turn 与 node:turn-settled 一一对应 —— 入场就失败的那一轮也不例外
  const badTurn = [];
  for (const [ns, e] of perNode) {
    for (const [k, v] of e.turn) if (v.open !== 1 || v.close !== 1) badTurn.push(`#${ns}/${k}: open=${v.open} close=${v.close}`);
  }
  ok(`${tag} ★ node:turn 与 node:turn-settled 一一对应`, badTurn.length === 0, badTurn.join("; "));

  // nodeSeq 从 0 起、稠密
  const nss = [...perNode.keys()].sort((a, b) => a - b);
  ok(`${tag} nodeSeq 从 0 起且稠密`, nss.every((s, i) => s === i), `拿到 ${nss.join(",")}`);

  // 每条 node:* 都带 nodeSeq;id 只出现在 node:observed;turnKey 恰好在六种事件上
  const TURNKEY_EVENTS = new Set(["node:turn", "node:started", "node:attempt", "node:attempt-settled", "node:progress", "node:turn-settled"]);
  const nodeEvents = lines.filter((l) => l.event.startsWith("node:"));
  ok(`${tag} 每条 node:* 都带 nodeSeq`, nodeEvents.every((l) => Number.isSafeInteger(l.payload.nodeSeq)));
  ok(`${tag} id 只出现在 node:observed`,
    nodeEvents.every((l) => (("id" in l.payload) === (l.event === "node:observed"))));
  ok(`${tag} turnKey 恰好出现在那六种事件上`,
    nodeEvents.every((l) => ("turnKey" in l.payload) === TURNKEY_EVENTS.has(l.event)));

  return { lines, graphId };
}

/* ============================================================ */
async function v1_single() {
  console.log("\n[V1] 单节点:事件顺序 / 归档布局 / 单轮不是特例是 N=1");
  const outDir = freshOut();
  const restore = envFor("okturn");
  try {
    await withBridge(async (b) => {
      await b.runNode({ id: "solo", agent: "omp", cwd: REPO, outDir, prompt: "看 nodes/upstream.md 再答", timeoutMs: 30000 });
    }, { viz: true, outDir });
  } finally { restore(); }

  const { lines, graphId } = checkInvariants("V1", outDir);
  const order = lines.map((l) => l.event);
  ok("V1 事件顺序正确", JSON.stringify(order) === JSON.stringify([
    "run:started", "node:observed", "node:turn", "node:started",
    "node:attempt", "node:attempt-settled", "node:turn-settled", "node:settled", "run:final",
  ]), order.join(" → "));

  const obs = evs(lines, "node:observed")[0].payload;
  ok("V1 node:observed 带 id / agent / access / cwd", obs.id === "solo" && obs.agent === "omp" && obs.access === "read" && !!obs.cwd);
  ok("V1 单轮节点的 prompt **不是** not-applicable(那是对话的判据)", obs.prompt.state === "present");
  ok("V1 没配 roleFile → role 是 not-applicable(先天不适用,不是拿不到)", obs.role.state === "not-applicable");
  ok("V1 spec 快照已归档", obs.spec.state === "present");
  ok("V1 推断边扫出来了", JSON.stringify(obs.inferredDeps) === JSON.stringify(["upstream"]), JSON.stringify(obs.inferredDeps));
  ok("V1 inferredDepsTruncated 恒在", obs.inferredDepsTruncated === false);
  ok("V1 declaredDeps 未传时是 []", JSON.stringify(obs.declaredDeps) === "[]");
  ok("V1 group 不传 → 整个键不出现(不是 null)", !("group" in obs));

  // ★ 单轮节点照样有 turns/main/ —— 归档布局里不存在"没有轮的那条老路"
  const rel = `nodes/.runs/${graphId}/0-solo`;
  ok("V1 ★ 归档布局:turns/main/prompt.md", has(outDir, `${rel}/turns/main/prompt.md`));
  ok("V1 ★ 归档布局:turns/main/attempt-1.output.md", has(outDir, `${rel}/turns/main/attempt-1.output.md`));
  ok("V1 归档布局:input.json", has(outDir, `${rel}/input.json`));
  ok("V1 归档布局:receipt.json", has(outDir, `${rel}/receipt.json`));
  ok("V1 read 节点没有 change.diff", !has(outDir, `${rel}/change.diff`));
  ok("V1 正常收场没有 scene/", !has(outDir, `${rel}/turns/main/scene`));

  const turn = evs(lines, "node:turn")[0].payload;
  ok("V1 node:turn.turnKey 恒为 main", turn.turnKey === "main");
  // ★ 可验的断言,不是约定
  ok("V1 ★ observed.prompt 与 turn.input 是同一份字节(ref 与 sha 都相同)",
    obs.prompt.ref === turn.input.ref && obs.prompt.sha256 === turn.input.sha256);
  const att = evs(lines, "node:attempt")[0].payload;
  ok("V1 ★ attempt1 的 input 就指向本轮 prompt.md", att.input.ref === turn.input.ref);
  ok("V1 ★ attempt1.inputSha256 必然等于 turn.input.sha256", att.inputSha256 === turn.input.sha256);

  const st = evs(lines, "node:settled")[0].payload;
  ok("V1 node:settled.execution=fresh", st.execution === "fresh");
  ok("V1 read 节点 outcome **缺席**(不是 null)", !("outcome" in st));
  ok("V1 read 节点 diff 是 not-applicable", st.diff.state === "not-applicable");
  ok("V1 node:settled 上**没有** scene(下沉到轮了)", !("scene" in st));
  ok("V1 node:settled 上**没有**节点级 attempts", !("attempts" in st));
  ok("V1 turns[] 恒有且下界是 1", Array.isArray(st.turns) && st.turns.length === 1);
  ok("V1 turns[0].key === main", st.turns[0].key === "main");
  ok("V1 turnSpecHash 是 hex32 不是 hex64", /^[0-9a-f]{32}$/.test(st.turns[0].turnSpecHash));
  // ★ artifact 指向的就是那一项 attempt 的产出,sha 三处一致
  const a0 = st.turns[0].attempts[0];
  ok("V1 ★ artifact.ref 指向最后一次成功复制的那份 attempt 产出", st.artifact.ref === a0.output.ref);
  ok("V1 ★ artifact.sha256 = attempts[].output.sha256 = turns[].output.sha256",
    st.artifact.sha256 === a0.output.sha256 && st.artifact.sha256 === st.turns[0].output.sha256);
}

/* ============================================================ */
async function v2_conversation() {
  console.log("\n[V2] 对话三轮:轮这一层完整");
  const outDir = freshOut();
  const restore = envFor("echoturn");
  try {
    await withBridge(async (b) => {
      await b.conversation({ id: "chat", agent: "omp", cwd: REPO, outDir }, async (turn) => {
        await turn({ key: "draft", prompt: "第一问", timeoutMs: 30000 });
        await turn({ key: "review", prompt: "第二问,参考 nodes/other.md", timeoutMs: 30000 });
        await turn({ key: "final", prompt: "第三问", timeoutMs: 30000 });
      });
    }, { viz: true, outDir });
  } finally { restore(); }

  const { lines, graphId } = checkInvariants("V2", outDir);
  ok("V2 三条 node:turn", evs(lines, "node:turn").length === 3);
  ok("V2 三条 node:turn-settled", evs(lines, "node:turn-settled").length === 3);
  ok("V2 三条 node:started(每轮各自排队各自起钟)", evs(lines, "node:started").length === 3);
  ok("V2 只有一条 node:observed(轮不是节点)", evs(lines, "node:observed").length === 1);
  ok("V2 只有一条 node:settled", evs(lines, "node:settled").length === 1);

  const obs = evs(lines, "node:observed")[0].payload;
  // ★ 页面判别「这是不是一段对话」的唯一判据
  ok("V2 ★ 对话节点的 prompt 是 not-applicable(唯一判据)", obs.prompt.state === "not-applicable");
  ok("V2 对话节点的 inferredDeps 恒 [](这一层没得扫)", JSON.stringify(obs.inferredDeps) === "[]");

  const turns = evs(lines, "node:turn").map((l) => l.payload);
  ok("V2 三轮的 key 各不相同", new Set(turns.map((t) => t.turnKey)).size === 3);
  const rv = turns.find((t) => t.turnKey === "review");
  ok("V2 ★ 逐轮的推断边(对话的头号用法)", JSON.stringify(rv.inferredDeps) === JSON.stringify(["other"]), JSON.stringify(rv.inferredDeps));

  // 每轮各自归档
  const rel = `nodes/.runs/${graphId}/0-chat`;
  for (const k of ["draft", "review", "final"]) {
    ok(`V2 归档 turns/${k}/prompt.md`, has(outDir, `${rel}/turns/${k}/prompt.md`));
    ok(`V2 归档 turns/${k}/attempt-1.output.md`, has(outDir, `${rel}/turns/${k}/attempt-1.output.md`));
  }
  // canonical 区的逐轮投影:必须带 .t-<key>,否则两轮的第 1 次会互相覆盖
  ok("V2 canonical 逐轮投影带 .t-<key>",
    has(outDir, "nodes/chat.t-draft.a1.md") && has(outDir, "nodes/chat.t-review.a1.md"));
  ok("V2 ★ 两轮的第 1 次产出内容不同(证明没互相覆盖)",
    fs.readFileSync(path.join(outDir, "nodes/chat.t-draft.a1.md"), "utf8")
      !== fs.readFileSync(path.join(outDir, "nodes/chat.t-review.a1.md"), "utf8"));

  const st = evs(lines, "node:settled")[0].payload;
  ok("V2 turns[] 三项且按发生顺序", st.turns.map((t) => t.key).join(",") === "draft,review,final");
  // ★ n 在每一轮内从 1 重新开始
  ok("V2 ★ 每轮的 attempt n 都从 1 重开", st.turns.every((t) => t.attempts[0].n === 1));
  const atts = evs(lines, "node:attempt").map((l) => l.payload);
  ok("V2 ★ 三轮各有一个 n===1(所以 (nodeSeq,n) 不是唯一键)",
    atts.filter((a) => a.n === 1).length === 3);
  ok("V2 每条 attempt 都带 turnKey(靠它才归得了位)", atts.every((a) => typeof a.turnKey === "string"));
}

/* ============================================================ */
async function v3_reask() {
  console.log("\n[V3] 打回重说:两次尝试各自独立");
  const outDir = freshOut();
  const restore = envFor("echoturn");
  try {
    await withBridge(async (b) => {
      await b.runNode({
        id: "picky", agent: "omp", cwd: REPO, outDir, prompt: "唯一串-bravo",
        timeoutMs: 30000, outputShape: { requiredKeys: ["findings"] },
      });
    }, { viz: true, outDir });
  } finally { restore(); }

  const { lines, graphId } = checkInvariants("V3", outDir);
  const as = evs(lines, "node:attempt").map((l) => l.payload);
  const ss = evs(lines, "node:attempt-settled").map((l) => l.payload);
  ok("V3 两条 node:attempt", as.length === 2 && as[0].n === 1 && as[1].n === 2);
  ok("V3 两条 node:attempt-settled(四种 status 都发)", ss.length === 2);
  ok("V3 两条都是 rejected", ss.every((s) => s.status === "rejected"));
  ok("V3 rejectedReason 只在 rejected 时出现且非空",
    ss.every((s) => typeof s.rejectedReason === "string" && s.rejectedReason.length > 0));
  ok("V3 两次的 output 各自 present", ss.every((s) => s.output.state === "present"));
  ok("V3 ★ 两次的产出 ref 不同(第 1 次没被第 2 次覆盖)", ss[0].output.ref !== ss[1].output.ref);
  ok("V3 ★ 两次的产出 sha 不同(内容确实不一样)", ss[0].output.sha256 !== ss[1].output.sha256);
  ok("V3 第 2 次的输入另存一份(n≥2 才有)",
    as[1].input.ref.endsWith("attempt-2.input.md"), as[1].input.ref);
  ok("V3 第 1 次的输入仍指向本轮 prompt.md", as[0].input.ref.endsWith("turns/main/prompt.md"));
  ok("V3 归档里两份产出都在",
    has(outDir, `nodes/.runs/${graphId}/0-picky/turns/main/attempt-1.output.md`) &&
    has(outDir, `nodes/.runs/${graphId}/0-picky/turns/main/attempt-2.output.md`));

  const st = evs(lines, "node:settled")[0].payload;
  ok("V3 节点结局 contract_error", st.status === "contract_error");
  ok("V3 turns[0].attempts 两项", st.turns[0].attempts.length === 2);
  ok("V3 ★ 顶层 artifact 是被判不合格的那份(语义是「最后一次成功复制」不是「采纳」)",
    st.artifact.ref === ss[1].output.ref);
}

/* ============================================================ */
async function v4_dup_id() {
  console.log("\n[V4] 撞 id → node:rejected{phase:lock}");
  const outDir = freshOut();
  const restore = envFor("okturn");
  try {
    await withBridge(async (b) => {
      // ⚠️ **谁抢到锁是不确定的** —— 两个调用在同一个 tick 里发出,先到 prepareRun 的那个赢。
      //    早先这里写死"第二个会被拒",于是另一半的时候 p1 抛出去、整个 harness 当场炸掉:
      //    一条**间歇性假红**。判据要写成"恰好一个被拒",不是"第几个被拒"。
      const grab = (prompt) => b.runNode({ id: "same", agent: "omp", cwd: REPO, outDir, prompt, timeoutMs: 30000 })
        .then((r) => ({ ok: r }), (e) => ({ _err: e }));
      const rs = await Promise.all([grab("a"), grab("b")]);
      const errs = rs.filter((r) => r._err);
      ok("V4 恰好一个被拒", errs.length === 1, `被拒 ${errs.length} 个`);
      ok("V4 被拒的那个是 UsageError", errs[0]?._err instanceof UsageError);
      ok("V4 另一个照常拿到回执", rs.find((r) => !r._err)?.ok?.status === "ok");
    }, { viz: true, outDir });
  } finally { restore(); }

  const { lines } = checkInvariants("V4", outDir);
  const rj = evs(lines, "node:rejected");
  ok("V4 恰好一条 node:rejected", rj.length === 1);
  ok("V4 phase === lock", rj[0]?.payload.phase === "lock", rj[0]?.payload.phase);
  ok("V4 error 是抛出去那个异常的消息", /并发运行|锁文件/.test(rj[0]?.payload.error || ""));
  // ★ 被拒的那个**也有 nodeSeq、也有 node:observed** —— 它只是没有 settled
  const rejSeq = rj[0].payload.nodeSeq;
  ok("V4 ★ 被拒的节点照样有 node:observed(拿到号的调用一定会发)",
    evs(lines, "node:observed").some((l) => l.payload.nodeSeq === rejSeq));
  ok("V4 ★ 被拒的节点**没有** node:settled(不许数两次)",
    !evs(lines, "node:settled").some((l) => l.payload.nodeSeq === rejSeq));
  ok("V4 第一个照常跑完(不受影响)", evs(lines, "node:settled").length === 1);
}

/* ============================================================ */
async function v5_cross_outdir() {
  console.log("\n[V5] 跨 outDir:当场拒 + 外来目录零文件");
  const outDir = freshOut();
  const alien = freshOut();
  const before = fs.readdirSync(alien).length;
  const restore = envFor("okturn");
  let err = null;
  try {
    await withBridge(async (b) => {
      try { await b.runNode({ id: "x", agent: "omp", cwd: REPO, outDir: alien, prompt: "a", timeoutMs: 30000 }); }
      catch (e) { err = e; }
    }, { viz: true, outDir });
  } finally { restore(); }
  ok("V5 当场报 UsageError", err instanceof UsageError);
  ok("V5 报错说清是两个 outDir", /outDir/.test(err?.message || "") && /withBridge/.test(err?.message || ""));
  // ⚠️ 断言瞄准的是**外来目录**,不是"整个进程一个文件都没写" ——
  //    本 graph 的 transcript 在回调之前就建好了,那是对的。
  ok("V5 ★ 外来目录里没有产生任何文件、锁或归档", fs.readdirSync(alien).length === before);
  ok("V5 对照:本 graph 的 transcript 确实建了", readTranscript(outDir).graphId !== null);
  // 这个节点**一个事件都不发**(连 nodeSeq 都没分配)
  const { lines } = readTranscript(outDir);
  ok("V5 ★ 被拒的这一路一个 node:* 事件都没有", lines.every((l) => !l.event.startsWith("node:")));
}

/* ============================================================ */
async function v6_reuse() {
  console.log("\n[V6] 复用命中:execution=reused,一条 node:turn 都不发");
  const outDir = freshOut();
  const restore = envFor("okturn");
  try {
    // 第一波:真跑(viz 开着,好让产出与回执都归档)
    await withBridge(async (b) => {
      await b.runNode({ id: "cached", agent: "omp", cwd: REPO, outDir, prompt: "看 nodes/dep1.md", timeoutMs: 30000 });
    }, { viz: true, outDir });
    // 第二波:同一个 outDir,指纹一致 → 命中复用
    await withBridge(async (b) => {
      await b.runNode({ id: "cached", agent: "omp", cwd: REPO, outDir, prompt: "看 nodes/dep1.md", timeoutMs: 30000, reuseIfSame: true });
    }, { viz: true, outDir });
  } finally { restore(); }

  // 两波 = 两份 transcript(一个 withBridge 一个 graph)
  const runsRoot = path.join(outDir, "nodes", ".runs");
  const ids = fs.readdirSync(runsRoot);
  ok("V6 两波 = 两份 transcript(不做跨波聚合)", ids.length === 2, `拿到 ${ids.length}`);
  // 取第二波(mtime 更新的那个)
  const second = ids.map((id) => ({ id, m: fs.statSync(path.join(runsRoot, id)).mtimeMs })).sort((a, b) => b.m - a.m)[0].id;
  const lines = fs.readFileSync(path.join(runsRoot, second, "transcript.jsonl"), "utf8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l));

  ok("V6 ★ 复用那波一条 node:turn 都不发", evs(lines, "node:turn").length === 0);
  ok("V6 ★ 也不发 node:attempt", evs(lines, "node:attempt").length === 0);
  const st = evs(lines, "node:settled")[0]?.payload;
  ok("V6 仍然有 node:settled(否则页面上它永远停在 observed)", !!st);
  ok("V6 execution === reused", st?.execution === "reused");
  ok("V6 ★ reused 不是 status —— status 仍是 ok", st?.status === "ok");
  ok("V6 turns[] 仍在(复用节点的推断边唯一来源)", Array.isArray(st?.turns) && st.turns.length === 1);
  ok("V6 ★ turns[].inferredDeps 兜住了推断边(否则第二遍跑边会凭空消失)",
    JSON.stringify(st?.turns?.[0]?.inferredDeps) === JSON.stringify(["dep1"]),
    JSON.stringify(st?.turns?.[0]?.inferredDeps));
  const final = evs(lines, "run:final")[0]?.payload;
  ok("V6 counts.reused === 1 且 ok === 1(子集不是并列)", final?.counts.reused === 1 && final?.counts.ok === 1);
}

/* ============================================================ */
async function v7_zero_turn() {
  console.log("\n[V7] 零轮两档必须分得开");
  // ① 一次都没调
  {
    const outDir = freshOut();
    const restore = envFor("okturn");
    let err = null;
    try {
      await withBridge(async (b) => {
        try { await b.conversation({ id: "empty", agent: "omp", cwd: REPO, outDir }, async () => {}); }
        catch (e) { err = e; }
      }, { viz: true, outDir });
    } finally { restore(); }
    const { lines } = checkInvariants("V7a", outDir);
    const rj = evs(lines, "node:rejected")[0]?.payload;
    ok("V7a phase === zero-turn", rj?.phase === "zero-turn", rj?.phase);
    ok("V7a error 说的是「一轮都没调」", /一次 turn\(\) 都没调/.test(rj?.error || ""));
    ok("V7a 抛的是 UsageError", err instanceof UsageError);
  }
  // ② 调过但每次都被拒,而且回调把异常吞了
  {
    const outDir = freshOut();
    const restore = envFor("okturn");
    let err = null;
    try {
      await withBridge(async (b) => {
        try {
          await b.conversation({ id: "swallowed", agent: "omp", cwd: REPO, outDir }, async (turn) => {
            try { await turn({ key: "bad/key", prompt: "x", timeoutMs: 1000 }); } catch {}
            try { await turn({ key: "also-bad", prompt: "y" /* 缺 timeoutMs */ }); } catch {}
          });
        } catch (e) { err = e; }
      }, { viz: true, outDir });
    } finally { restore(); }
    const { lines } = checkInvariants("V7b", outDir);
    const rj = evs(lines, "node:rejected")[0]?.payload;
    // ★ 两档必须分得开:zero-turn 会把"调过但被拒了"谎报成"压根没调过",而处置完全不同
    ok("V7b ★ phase === turn-validation(**不是** zero-turn)", rj?.phase === "turn-validation", rj?.phase);
    ok("V7b error 说清调了几次", /调用了 2 次 turn\(\)/.test(rj?.error || ""), rj?.error?.slice(0, 120));
    ok("V7b error 说清最后一次没进去的原因", /timeoutMs/.test(rj?.error || ""));
    ok("V7b ★ 不说「一次 turn() 都没调」", !/一次 turn\(\) 都没调/.test(rj?.error || ""));
    ok("V7b 抛的是 UsageError", err instanceof UsageError);
    // 校验就没过的轮**一个事件都不发**
    ok("V7b ★ 当场被拒的轮一条 node:turn 都不发", evs(lines, "node:turn").length === 0);
  }
}

/* ============================================================
   V8 数据面:SSE 线格式与 /file 的四道闸
   ============================================================ */

/** 极简 SSE 客户端:收满 `wantFrames` 帧或超时就返回解析好的帧。 */
function sseCollect(url, ms = 4000) {
  return new Promise((resolve) => {
    const frames = [];
    let head = null, buf = "";
    const req = http.get(url + "events", (res) => {
      head = res.headers;
      res.setEncoding("utf8");
      res.on("data", (d) => {
        buf += d;
        let i;
        // 一帧 = 若干行 + 一个空行。**空行就是帧结束。**
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const raw = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (raw.startsWith(":")) { frames.push({ comment: raw }); continue; }
          const m = /^event: (.+)\ndata: ([\s\S]*)$/.exec(raw);
          if (m) frames.push({ event: m[1], data: m[2] });
        }
      });
    });
    req.on("error", () => {});
    setTimeout(() => { try { req.destroy(); } catch {} resolve({ frames, head }); }, ms);
  });
}

function httpReq(url, opts = {}) {
  return new Promise((resolve) => {
    const req = http.request(url, opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", (e) => resolve({ status: 0, headers: {}, body: Buffer.from(String(e)) }));
    req.end();
  });
}

async function v8_dataplane() {
  console.log("\n[V8] 数据面:SSE 线格式 / /file 四道闸");
  const outDir = freshOut();
  const restore = envFor("okturn");
  let url = null;
  try {
    await withBridge(async (b) => {
      url = b.vizUrl;
      await b.runNode({ id: "dp", agent: "omp", cwd: REPO, outDir, prompt: "hi", timeoutMs: 30000 });
    }, { viz: true, outDir });
  } finally { restore(); }
  ok("V8 withBridge 暴露了 viewer 的 URL", typeof url === "string" && url.startsWith("http://127.0.0.1:"));
  if (!url) return;

  const { lines, graphId } = readTranscript(outDir);
  const { frames, head } = await sseCollect(url);

  // ⚠️ Content-Type 不是 text/event-stream,浏览器原生 EventSource **直接判错**,
  //    页面一个事件都收不到,而服务端日志上看起来一切正常。
  ok("V8 Content-Type 是 text/event-stream; charset=utf-8",
    (head?.["content-type"] || "").includes("text/event-stream"), head?.["content-type"]);
  ok("V8 Cache-Control 含 no-transform", (head?.["cache-control"] || "").includes("no-transform"));
  ok("V8 带 X-Accel-Buffering: no", head?.["x-accel-buffering"] === "no");
  ok("V8 不发 Content-Length", !("content-length" in (head || {})));

  const named = frames.filter((f) => f.event);
  ok("V8 第一帧是 hello", named[0]?.event === "hello", named[0]?.event);
  const hello = JSON.parse(named[0].data);
  ok("V8 hello 带 graphId 与 v", hello.graphId === graphId && hello.v === 1);

  const tx = named.filter((f) => f.event === "tx");
  ok("V8 回放拿到了全部事件", tx.length === lines.length, `${tx.length} vs ${lines.length}`);
  // ★ tx 的 data 是**原样透传** —— viewer 是搬运工,不是第二个 writer。
  const rawLines = fs.readFileSync(path.join(outDir, "nodes", ".runs", graphId, "transcript.jsonl"), "utf8")
    .split("\n").filter(Boolean);
  ok("V8 ★ tx 的 data 与 transcript 那一行**逐字节相同**(不重新序列化)",
    tx.every((f, i) => f.data === rawLines[i]), tx[0]?.data?.slice(0, 60));

  // 控制槽:正常收场时 transcript 里有 run:final,不需要 owner-final
  const ctrl = named.filter((f) => f.event === "control");
  ok("V8 健康路径不发任何 control 帧(判定第 1 档按 transcript 说的算)", ctrl.length === 0,
    ctrl.map((c) => c.data).join("; "));

  // ---- /file 的四道闸 ----
  const st = lines.find((l) => l.event === "node:settled").payload;
  const ref = st.artifact.ref;
  const okRes = await httpReq(`${url}file?ref=${encodeURIComponent(ref)}`);
  ok("V8 /file 合法 ref → 200", okRes.status === 200, String(okRes.status));
  ok("V8 /file Content-Type 恒为 text/plain(绝不按扩展名回 html)",
    (okRes.headers["content-type"] || "").includes("text/plain"));
  ok("V8 /file 带 nosniff 与 no-store",
    okRes.headers["x-content-type-options"] === "nosniff" && okRes.headers["cache-control"] === "no-store");
  ok("V8 /file Content-Length 是**本次响应体**的字节数",
    Number(okRes.headers["content-length"]) === okRes.body.length);
  // ★ 页面靠这个头与事件里的 sha256 对证
  ok("V8 ★ X-Graph-Sha256 与事件里的 sha256 一致", okRes.headers["x-graph-sha256"] === st.artifact.sha256);
  ok("V8 ★ 响应体不是 JSON 包装(页面可直接算 SHA 对证)",
    crypto.createHash("sha256").update(okRes.body).digest("hex") === st.artifact.sha256);

  const head200 = await httpReq(`${url}file?ref=${encodeURIComponent(ref)}`, { method: "HEAD" });
  ok("V8 HEAD 同样处理且带 X-Graph-Sha256",
    head200.status === 200 && head200.headers["x-graph-sha256"] === st.artifact.sha256 && head200.body.length === 0);

  const post = await httpReq(`${url}file?ref=${encodeURIComponent(ref)}`, { method: "POST" });
  ok("V8 其它方法 405", post.status === 405);
  // 缺了 Allow 就不是一个合法的 405
  ok("V8 405 必须带 Allow: GET, HEAD", (post.headers.allow || "").replace(/\s/g, "") === "GET,HEAD", post.headers.allow);

  ok("V8 缺 ref → 400", (await httpReq(`${url}file`)).status === 400);
  ok("V8 含 .. → 400", (await httpReq(`${url}file?ref=${encodeURIComponent(`nodes/.runs/${graphId}/../../x`)}`)).status === 400);
  ok("V8 绝对路径 → 400", (await httpReq(`${url}file?ref=${encodeURIComponent("D:/x/y.md")}`)).status === 400);
  // ⚠️ **收到 out-dir 就不够**:canonical 区就在 out-dir 里,但它不在归档范围内
  ok("V8 ★ canonical 区的 ref → 403(收到 out-dir 是不够的)",
    (await httpReq(`${url}file?ref=${encodeURIComponent("nodes/dp.md")}`)).status === 403);
  ok("V8 ★ 越界到 out-dir 根 → 403",
    (await httpReq(`${url}file?ref=${encodeURIComponent(".env")}`)).status === 403);
  // 目录必须拒(这正是 scene 要做成容器、每个子文件各自带 ref 的原因)
  ok("V8 ★ 目录 → 403(不是 200 也不是 404)",
    (await httpReq(`${url}file?ref=${encodeURIComponent(`nodes/.runs/${graphId}/0-dp/turns`)}`)).status === 403);
  // ⚠️ 403 与 404 必须分开:合成一档,一次越界尝试与一份真丢了的产出就长得一样,
  //    而这两件事的处置完全相反。
  ok("V8 ★ 范围内但不存在 → 404(与 403 分开)",
    (await httpReq(`${url}file?ref=${encodeURIComponent(`nodes/.runs/${graphId}/0-dp/no-such-file.md`)}`)).status === 404);

  ok("V8 / 返回页面", (await httpReq(url)).status === 200);
  ok("V8 未知路径 404", (await httpReq(`${url}nope`)).status === 404);
}

/* ============================================================ */
/**
 * V9 强杀路径:transcript 里**没有** run:final,管道 EOF ⟹ 服务端必须发 owner-ended。
 *
 * 为什么单独造场景而不是复用前面那些:前面每一条都是有序收场,transcript 里都有 run:final,
 * 那一档由 transcript 自己说了算。**只有拿不到 run:final 时,页面才无从判断
 * 「还在跑、暂时没消息」与「跑完了、就是没有 final」** —— 这一帧就是为那个岔口存在的。
 * 不测它,no_finish 与 log_broken_unknown 两档在页面上永远走不到。
 */
async function v9_owner_ended() {
  console.log("\n[V9] 强杀(无 run:final)→ control{owner-ended}");
  const outDir = freshOut();
  const graphId = "gr-v9-" + Date.now().toString(36);
  const root = path.join(outDir, "nodes", ".runs", graphId);
  fs.mkdirSync(root, { recursive: true });
  // 一份**只写到一半**的 transcript:开了头,没有结尾。
  const mk = (seq, event, payload) => JSON.stringify({ v: 1, seq, ts: 1000 + seq, graphId, event, payload });
  fs.writeFileSync(path.join(root, "transcript.jsonl"),
    mk(0, "run:started", { outDir, maxConcurrent: 4 }) + "\n" +
    mk(1, "node:observed", { nodeSeq: 0, id: "cut", agent: "omp", access: "read", cwd: REPO,
      model: null, effort: null, spec: { state: "not-applicable" }, prompt: { state: "not-applicable" },
      role: { state: "not-applicable" }, declaredDeps: [], inferredDeps: [], inferredDepsTruncated: false }) + "\n");

  const { fork } = await import("node:child_process");
  const serve = path.join(REPO, "skills", "agent-bridge-graph", "viz", "serve.mjs");
  const child = fork(serve, [], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    env: { ...process.env, VIZ_OUT_DIR: outDir, VIZ_GRAPH_ID: graphId, VIZ_PORT: "0" },
    windowsHide: true,
  });
  const url = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("viewer 没报出端口")), 15000);
    child.once("exit", (c) => { clearTimeout(t); reject(new Error("viewer 提前退出 " + c)); });
    child.on("message", (m) => { if (m?.kind === "viz-listening") { clearTimeout(t); resolve(m.url); } });
  });

  // 先确认**还活着的时候不发**这一帧 —— 否则一条恒发的帧测不出任何东西。
  const before = await sseCollect(url, 1500);
  ok("V9 owner 还在时不发 owner-ended",
    !before.frames.some((f) => f.event === "control" && /owner-ended/.test(f.data || "")));

  // 管道 EOF = owner 结束。**这是判活的唯一合同。**
  child.disconnect();
  await new Promise((r) => setTimeout(r, 1200));

  const after = await sseCollect(url, 2000);
  const ctrl = after.frames.filter((f) => f.event === "control").map((f) => JSON.parse(f.data));
  ok("V9 ★ 管道 EOF 之后必须发 owner-ended", ctrl.some((c) => c.kind === "owner-ended"),
    JSON.stringify(ctrl));
  ok("V9 没有 run:final 时也不伪造 owner-final", !ctrl.some((c) => c.kind === "owner-final"));
  ok("V9 事件照常回放(结束不等于把已有的记录丢掉)",
    after.frames.filter((f) => f.event === "tx").length === 2);

  try { child.kill(); } catch { /* 已经退了 */ }
}

/* ============================================================ */
async function main() {
  console.log(`[harness] 运行目录 ${RUN_ROOT}`);
  await v1_single();
  await v2_conversation();
  await v3_reask();
  await v4_dup_id();
  await v5_cross_outdir();
  await v6_reuse();
  await v7_zero_turn();
  await v8_dataplane();
  await v9_owner_ended();
  console.log(`\n${"=".repeat(56)}`);
  console.log(`  graph-viz: ${pass} passed, ${fail} failed`);
  console.log(`${"=".repeat(56)}\n`);
  try { fs.rmSync(RUN_ROOT, { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("[harness] 自己炸了:", e); process.exit(1); });
