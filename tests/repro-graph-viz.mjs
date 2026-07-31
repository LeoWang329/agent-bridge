// Hermetic 回归:viz **开着**时的事件流与归档(施工清单 #8~#12)。
// 全程 fake-omp,零真实模型消耗、零网络。
//
//   node tests/repro-graph-viz.mjs
//
// 这份测试证的是 EVENTS.md 那几条**不变式**,不是"有没有发事件":
//   V1 单节点        —— 13 种事件的顺序 / 归档布局 / **单轮不是特例是 N=1**(turns/main/ 照样有)
//   V2 对话三轮      —— 轮这一层完整;每轮各自归档;attempt 的 n 在每轮内从 1 重开
//   V3 打回重说      —— 两条 attempt-settled,第 1 条 rejected 带原因、第 2 条各自独立产出
//   V4 撞 id         —— node:rejected{phase:"lock"},**且没有 node:settled**(不许数两次)
//   V5 跨 outDir     —— 当场拒 + **外来目录零文件**
//   V6b 复用带 reask 的回执 —— 两次尝试的原件各自归档、各是各的字节
//   V6c 审计原件被改过/被删/路径被换 —— 复用必须当场拒,不许把篡改字节当证据
//   V6 复用命中      —— execution:"reused" + **一条 node:turn 都不发** + 推断边仍在
//   V7 零轮两档      —— zero-turn 与 turn-validation **必须分得开**
//   V8 数据面        —— SSE 线格式(含 tx 逐字节透传)/ /file 的四道闸(400/403/404/405 分得开)
//   V9 强杀路径      —— 没有 run:final 时,管道 EOF 必须变成 control{owner-lost};与 owner-final 互斥;健康路径不发
//   V10 两万条回放   —— 回放期间服务端仍响应别的请求(**同步整文件读会在这一条上红**)
//   V12 write 节点     —— 顶层 diffRef 的传递闭包 / workspaceSummary 只在回执没归档成功时出现
//   V12b 空提交       —— delivered + **零字节** diff:页面判"净改动为零"的唯一形状
//   V11 干净工作树   —— 在**新建的临时 git 仓库**里跑:本仓库 .graph/ 已 gitignore,在这儿测恒绿
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
import { withBridge, UsageError } from "../skills/agent-bridge-graph/tools/node-core.mjs";
/* ⚠️ 这一份是**照着 EVENTS.md 的散文**写的第二实现,刻意不经过 viz-events.mjs 的 schema。
      schema 只管单个字段的形状,管不了「这两处 sha256 必须相等」这类跨字段等式;
      而这条回归的价值正在于:**写方一旦漂离合同,这里当场变红** —— 拿写方的 schema
      去验写方造的事件,验的只是"我和我自己一致"。 */
import { checkInvariants as contractInvariants } from "./contract-invariants-graph.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
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
/** V12 那次**正常交付**的 diff —— V12b 拿它当"非零字节"的对照。 */
let v12DeliveredDiff = null;
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

  /* ★ 合同里那些**跨字段的等式**(§1.3 / §3.1 / §3.2 / §5.8)。
        `archiveRoot: outDir` 让它顺带验一遍"磁盘上那份与事件里记的 sha256/byteCount
        逐字节一致" —— 页面正是靠这个指纹判断"我打开的是不是当时那一份"。 */
  for (const r of contractInvariants(lines, { archiveRoot: outDir })) {
    if (r.weak) continue;
    ok(`${tag} 合同 ${r.name}`, r.ok, r.detail);
  }

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
  ok("V1 ★ read 节点永远没有 workspaceSummary(那是给 write 节点找现场用的)",
    !("workspaceSummary" in st));
  {
    /* ⚠️ 顶层 `diffRef` 对 read 节点是**键在、值为 null** —— 不是省略。
          §3.1 那条口径("不许用缺席表达未知")在这里同样成立:按合同去读顶层 diffRef 的
          消费方,拿到 null 才知道"这个节点本来就没有 diff",拿不到键只能靠猜。 */
    const rj = JSON.parse(fs.readFileSync(path.join(outDir, st.receipt.ref), "utf8"));
    ok("V1 ★ 归档回执的顶层 diffRef 是键在、值为 null", "diffRef" in rj && rj.diffRef === null,
      JSON.stringify(rj.diffRef));
    ok("V1 ★ canonical 区的绝对路径已抹掉(没有 diffPath / artifactPath)",
      !("diffPath" in rj) && !("artifactPath" in rj), JSON.stringify(Object.keys(rj).filter((k) => /Path$/.test(k))));
  }
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
/**
 * 复用一张**带「打回重说」**的旧回执。
 *
 * ⚠️ 这一段是 #37 那个修复的门禁,别把它并进 V6 —— V6 那个节点只有一次尝试,
 *    "逐次归档"与"只归档最后一份"在它身上**长得一模一样**,考不出任何东西。
 *
 * 考的是这句话:`#1 rejected` 那次的产出**当初真的落过盘**(keepAudit 在校验之前跑),
 * 所以复用回来时它必须仍是 `present` 且**是它自己那份字节**。
 * 早先的实现把它标成 `fingerprint-only`(= 否认一份确实存在的证据),
 * 更早一版把**最终正确答案**挂到了被打回的那一次名下(两条信息都错,还互相印证)。
 */
async function v6b_reuse_reask() {
  console.log("\n[V6b] 复用一张带「打回重说」的回执:两次尝试各自的原件都要还在");
  const outDir = freshOut();
  const spec = { id: "picky2", agent: "omp", cwd: REPO, outDir, prompt: "唯一串-charlie",
                 timeoutMs: 30000, outputShape: { requiredKeys: ["findings"] } };
  const restore = envFor("reaskturn");
  try {
    // 第一波:真跑 —— #1 不合格被打回、#2 合格,节点 ok
    await withBridge(async (b) => { await b.runNode({ ...spec }); }, { viz: true, outDir });
    // 第二波:指纹一致 → 命中复用
    await withBridge(async (b) => { await b.runNode({ ...spec, reuseIfSame: true }); }, { viz: true, outDir });
  } finally { restore(); }

  const runsRoot = path.join(outDir, "nodes", ".runs");
  const ids = fs.readdirSync(runsRoot);
  ok("V6b 两波 = 两份 transcript", ids.length === 2, `拿到 ${ids.length}`);
  const sorted = ids.map((id) => ({ id, m: fs.statSync(path.join(runsRoot, id)).mtimeMs })).sort((a, b) => b.m - a.m);
  const second = sorted[0].id;
  const readEv = (gid) => fs.readFileSync(path.join(runsRoot, gid, "transcript.jsonl"), "utf8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l));

  // 先确认第一波真的走了「打回重说」这条路(否则后面全是空考)
  const first = readEv(sorted[1].id);
  const fs1 = evs(first, "node:attempt-settled").map((l) => l.payload);
  ok("V6b 前提:第一波确实打回重说过(#1 rejected / #2 accepted)",
    fs1.length === 2 && fs1[0].status === "rejected" && fs1[1].status === "accepted",
    JSON.stringify(fs1.map((s) => s.status)));
  ok("V6b 前提:第一波节点收在 ok(不是 contract_error)",
    evs(first, "node:settled")[0]?.payload.status === "ok");

  const lines = readEv(second);
  const st = evs(lines, "node:settled")[0]?.payload;
  ok("V6b 第二波是复用", st?.execution === "reused" && st?.status === "ok");
  const atts = st?.turns?.[0]?.attempts || [];
  ok("V6b 复用回执里两次尝试都在", atts.length === 2, String(atts.length));

  const o1 = atts[0]?.output, o2 = atts[1]?.output;
  ok("V6b ★ 被打回那次(#1)的产出仍是 present —— 它当初真的落过盘",
    o1?.state === "present", JSON.stringify(o1));
  ok("V6b ★ 而且**不是** fingerprint-only(那句话等于否认一份存在的证据)",
    o1?.code !== "fingerprint-only", JSON.stringify(o1));
  ok("V6b ★ #1 与 #2 是两份不同的字节(不是把最终答案挂到被打回那次名下)",
    !!o1?.ref && !!o2?.ref && o1.ref !== o2.ref && o1.sha256 !== o2.sha256,
    `${o1?.ref} / ${o2?.ref}`);
  /* ⚠️ 两套命名别搞混:canonical 区的审计原件叫 `<id>.a<n>.md`,
        **归档区**(ref 指向的那份)叫 `turns/<key>/attempt-<n>.output.md`。
        这里要考的是归档区 —— 复用回来的两次尝试各自落在**自己那个 attempt-N**,
        而不是两条 ref 指向同一份文件。 */
  ok("V6b ★ 两条 ref 落在各自的 attempt-N(不是两条指向同一份)",
    /\/attempt-1\.output\.md$/.test(o1?.ref || "") && /\/attempt-2\.output\.md$/.test(o2?.ref || ""),
    `${o1?.ref} / ${o2?.ref}`);
  ok("V6b ★ 两份归档在**第二波自己的**归档根下真实存在(不是指回第一波)",
    !!o1?.ref && !!o2?.ref && o1.ref.startsWith(`nodes/.runs/${second}/`) &&
    has(outDir, o1.ref) && has(outDir, o2.ref), `${o1?.ref}`);
  // 字节要对得上:被打回那份的内容就是当初那句不合格的话
  if (o1?.ref && has(outDir, o1.ref)) {
    const body1 = fs.readFileSync(path.join(outDir, o1.ref), "utf8");
    ok("V6b ★ #1 归档里躺着的确实是**被判不合格的那段原话**",
      /REASK_BAD_1/.test(body1), body1.slice(0, 60));
  } else ok("V6b ★ #1 归档里躺着的确实是被判不合格的那段原话", false, "文件不在");
  // 顶层 artifact 是「最后一次成功复制」= #2
  ok("V6b 顶层 artifact 指向 #2(最后一次成功复制)",
    st?.artifact?.state === "present" && st.artifact.sha256 === o2?.sha256,
    JSON.stringify(st?.artifact));
  ok("V6b ★ 复用那波仍然一条 node:turn / node:attempt 都不发",
    evs(lines, "node:turn").length === 0 && evs(lines, "node:attempt").length === 0);

  /* ---- 输入:attempt 1 找得回来,n≥2 只剩指纹(§5.9) ---- */
  const i1 = atts[0]?.input, i2 = atts[1]?.input;
  ok("V6b ★ attempt 1 的**提问原文**找得回来 —— 这一次刚冻结的同一段字节就在归档里",
    i1?.state === "present", JSON.stringify(i1));
  ok("V6b ★ 而且它指的就是本轮的 prompt.md(不另存一份)",
    /\/turns\/main\/prompt\.md$/.test(i1?.ref || "") && i1?.ref.startsWith(`nodes/.runs/${second}/`),
    i1?.ref);
  ok("V6b ★ 落盘前拿指纹对过证:归档那份的 sha 必须等于回执记的 inputSha256",
    i1?.sha256 === atts[0]?.inputSha256, `${i1?.sha256} ≠ ${atts[0]?.inputSha256}`);
  ok("V6b ★ 归档里那个文件真在,内容就是当初的提问",
    !!i1?.ref && has(outDir, i1.ref) &&
    fs.readFileSync(path.join(outDir, i1.ref), "utf8").includes("唯一串-charlie"),
    i1?.ref);
  /* ⚠️ n≥2 的输入是当时按模板拼出来的**重说提示**,这一次没有它 —— 只剩指纹。
        这一条是**边界**:把上面那条恢复逻辑无差别套到每一次,就会凭空造出一段
        "当初的重说提示",而那是**伪造历史**。 */
  ok("V6b ★ n≥2 的输入只剩指纹(不许凭空造一段重说提示出来)",
    i2?.state === "unavailable" && i2?.code === "fingerprint-only", JSON.stringify(i2));
  ok("V6b n≥2 的输入指纹本身照常记着(那是它唯一能自证的东西)",
    /^[0-9a-f]{64}$/.test(atts[1]?.inputSha256 || ""), atts[1]?.inputSha256);
}

/* ============================================================ */
/**
 * 审计原件的完整性闸。
 *
 * ⚠️ 复用会把**每一次尝试的审计原件**重新归档进本次 graph、按当前磁盘字节**现算**一个 sha
 * 发到 wire 上,页面据此说"这就是当初第 n 次尝试写下的东西"。
 * 所以"改一下 `<id>.a1.md` 再复用"必须**当场被拒** —— 否则第二个 graph 会把篡改过的字节
 * 包装成一份崭新的 `present`,指纹与篡改后的内容自洽,**页面上一点红都不会有**。
 * V6b 只断言归档里躺着 `REASK_BAD_1`,在正文后面**追加**一段照样全绿 —— 那条考的是
 * "挂对了没有",不是"有没有被改过"。两件事,两条闸。
 */
async function v6c_attempt_tamper() {
  console.log("\n[V6c] 审计原件被改过 → 复用当场拒(不是静默把篡改字节当证据)");
  /** `opts.spec` 覆盖任务单、`opts.mode` 换假后端 —— 测"上界跟着 `reask` 走"那一格要 `reask:0`。
   *  ⚠️ `reask:0` 配不了 `reaskturn`:那个模式第一次故意答不合格,没有第二次就直接挂了,
   *     连回执都不是 ok,复用闸压根走不到。所以那一格换 `okturn` 并去掉 `outputShape`。 */
  const mk = async (mutate, opts = {}) => {
    const outDir = freshOut();
    const spec = { id: "audit", agent: "omp", cwd: REPO, outDir, prompt: "唯一串-delta",
                   timeoutMs: 30000, outputShape: { requiredKeys: ["findings"] }, ...(opts.spec || {}) };
    if (spec.outputShape === null) delete spec.outputShape;   // 显式"这一格不要弱检查"
    const restore = envFor(opts.mode || "reaskturn");
    let err = null;
    try {
      await withBridge(async (b) => { await b.runNode({ ...spec }); }, { viz: true, outDir });
      mutate(outDir);
      await withBridge(async (b) => { await b.runNode({ ...spec, reuseIfSame: true }); }, { viz: true, outDir });
    } catch (e) { err = e; } finally { restore(); }
    return { outDir, err };
  };

  // ① 对照:什么都不动 → 照常复用
  {
    const { err } = await mk(() => {});
    ok("V6c 对照:原封不动时复用照常成功", err === null, err?.message?.slice(0, 120));
  }
  // ② 被打回那次的审计原件被**追加**了一段
  {
    const { err } = await mk((outDir) => {
      fs.appendFileSync(path.join(outDir, "nodes", "audit.a1.md"), "\n悄悄加一句\n", "utf8");
    });
    ok("V6c ★ 改了 a1 → 复用被拒", !!err, "居然放行了");
    ok("V6c ★ 而且说得出是第 1 次尝试的原件对不上",
      /第 1 次尝试的审计原件内容与回执记录的不一致/.test(err?.message || ""), err?.message?.slice(0, 160));
    ok("V6c 拒的方式是 UsageError(用法错才抛,不是把它变成一次失败的执行)",
      err?.name === "UsageError", err?.name);
  }
  // ③ 审计原件被删
  {
    const { err } = await mk((outDir) => {
      fs.rmSync(path.join(outDir, "nodes", "audit.a1.md"), { force: true });
    });
    ok("V6c ★ 删了 a1 → 复用被拒(回执说留了一份,那份必须还在)",
      /第 1 次尝试的审计原件缺失/.test(err?.message || ""), err?.message?.slice(0, 160));
  }
  // ④ 回执里那条路径被指到**内容完全相同**的另一个文件。
  //    ⚠️ 这一格**必须让替身与记录的 SHA 自洽** —— 早先它指向 a2(内容不同),
  //       于是 SHA 那道闸先拒了它,路径闸有没有区分度**根本没被考到**:
  //       把生产代码里的路径等值检查整个删掉,测试照样全绿。
  {
    const { err } = await mk((outDir) => {
      const twin = path.join(outDir, "nodes", "audit.twin.md");
      fs.copyFileSync(path.join(outDir, "nodes", "audit.a1.md"), twin);   // 同一份字节 ⇒ 同一个 SHA
      const rp = path.join(outDir, "nodes", "audit.receipt.json");
      const j = JSON.parse(fs.readFileSync(rp, "utf8"));
      j.attempts[0].artifactPath = twin;            // 只有路径变了,SHA 仍然对得上
      fs.writeFileSync(rp, JSON.stringify(j, null, 2), "utf8");
    });
    ok("V6c ★ 路径被指到别处(内容/SHA 都自洽)→ 仍然拒 —— 路径闸自己有区分度",
      /第 1 次尝试的审计原件路径与本次算出来的不一致/.test(err?.message || ""), err?.message?.slice(0, 200));
  }
  /* ⑦ **顺序被对调**:两个文件、两个 SHA 全都对得上,但 `emitReusedSettled` 按数组顺序
        取"最后一次"当该轮产出与顶层交付物 —— 对调之后**被打回的那一份**成了交付物,
        而不变式③也按同一个被篡改的顺序取最后一项,**生产者与校验器一起假绿**。 */
  {
    const { err } = await mk((outDir) => {
      const rp = path.join(outDir, "nodes", "audit.receipt.json");
      const j = JSON.parse(fs.readFileSync(rp, "utf8"));
      j.attempts.reverse();
      fs.writeFileSync(rp, JSON.stringify(j, null, 2), "utf8");
    });
    ok("V6c ★ attempts 顺序被对调 → 拒(顺序决定了哪一次是最终产出)",
      /attempts\[\] 的次序坏了/.test(err?.message || ""), err?.message?.slice(0, 200));
  }
  // ⑧ `n` 被塞成一段能逃出 nodesDir 的路径
  {
    const { err } = await mk((outDir) => {
      const rp = path.join(outDir, "nodes", "audit.receipt.json");
      const j = JSON.parse(fs.readFileSync(rp, "utf8"));
      j.attempts[0].n = "../../escape";
      fs.writeFileSync(rp, JSON.stringify(j, null, 2), "utf8");
    });
    ok("V6c ★ n 被塞成 ../.. → 拒(它同时参与'可信路径计算'与归档目标路径)",
      /attempts\[\] 的次序坏了/.test(err?.message || ""), err?.message?.slice(0, 200));
  }
  /* ⑪~⑮ 字段级的几道闸,**每一条都要能单独考出来**。
     ⚠️ "顺序对调"那一格先撞上 `n` 次序闸,所以它证明不了下面这些 —— 每一格都只动**一个**字段,
        别的字段(n / 路径 / SHA)全保持合法,这样红了就只可能是被考的那道闸。 */
  const only = async (label, mutate, re, opts) => {
    const { err } = await mk((outDir) => {
      const rp = path.join(outDir, "nodes", "audit.receipt.json");
      const j = JSON.parse(fs.readFileSync(rp, "utf8"));
      mutate(j);
      fs.writeFileSync(rp, JSON.stringify(j, null, 2), "utf8");
    }, opts);
    ok(`V6c ★ ${label}`, re.test(err?.message || ""), err ? err.message.slice(0, 180) : "居然放行了");
  };

  // ⑪ 末次被改成 rejected —— 一轮收在 ok,末次不可能是被打回的那次
  await only("末次 status 被改成 rejected → 拒(ok 的轮末次必是 accepted/no-output)",
    (j) => { j.attempts[j.attempts.length - 1].status = "rejected"; },
    /最后一次尝试是/);
  // ⑫ 非末次被改成 accepted —— 走到下一次的唯一出口就是"这一次被判不合格"
  await only("第 1 次被改成 accepted → 拒(有下一次就说明这一次被打回了)",
    (j) => { j.attempts[0].status = "accepted"; },
    /只有.{0,8}被判不合格.{0,8}才会有下一次|非末次只可能是 rejected/);
  // ⑬ status 塞一个枚举外的值
  await only("status 塞枚举外的值 → 拒(不许等到事件层才失败——那里异常被吞掉)",
    (j) => { j.attempts[0].status = "totally-fine"; },
    /不在封闭枚举里/);
  // ⑭ 输入指纹被抹掉
  await only("inputSha256 被抹掉 → 拒(那是这一次唯一能自证的东西)",
    (j) => { delete j.attempts[0].inputSha256; },
    /没有合法的输入指纹/);
  // ⑮ 塞进第三次尝试(reask 最多 1 ⇒ 最多两次)
  await only("塞进第 3 次尝试 → 拒(reask 只能是 0/1,次数有硬上界)",
    (j) => { j.attempts.push({ ...j.attempts[1], n: 3 }); },
    /最多只可能有 2 次/);
  // ⑯ no-output 却记着非零字节 —— 自相矛盾
  await only("记成 no-output 却又记了字节数 → 拒(自相矛盾)",
    (j) => { const a = j.attempts[j.attempts.length - 1]; a.status = "no-output"; a.byteCount = 42; },
    /自相矛盾/);
  /* ⑰ **同一道闸,换一种坏法。** ⑭ 删掉整个 `inputSha256`,那只考出"缺了会不会拒" ——
        把生产代码换成 `if (!a.inputSha256)` 这种非空检查,⑭ **照样红**,于是"查的是形状"
        这件事从来没被考到。而一段截断/乱码的指纹是**非空的**:它会被原样重新发布到 wire 上,
        到**事件 schema** 那里才被拒,而那里被 `guard()` 吞掉 —— 业务照常返回"复用成功",
        页面却永远等不到 `node:settled`。**一格删、一格改,两格合起来才钉得住这道闸。** */
  await only("inputSha256 被换成一段非 hex64 → 同样拒(考的是形状,不是'有没有')",
    (j) => { j.attempts[0].inputSha256 = "deadbeef"; },
    /没有合法的输入指纹/);
  /* ⑱ **上界必须真的跟着 `reask` 走。** ⑮ 只跑默认的 `reask:1`(上界 2),
        把生产代码里的 `reask + 1` 写死成常量 2,⑮ **照样红** —— 它证不出这道闸读过 `reask`。
        这一格用 `reask:0`(上界 1):一次合法的单次尝试,再往回执里塞第二次。
        写死成 2 的实现会放它过去,然后在**别的**闸上以**别的**理由拒,断言就红。 */
  {
    const noReask = { spec: { reask: 0, outputShape: null }, mode: "okturn" };
    const { err: ctl } = await mk(() => {}, noReask);
    ok("V6c 对照:reask:0 的单次尝试照常复用得了", ctl === null, ctl?.message?.slice(0, 140));
    await only("reask:0 却记了 2 次尝试 → 拒(上界跟着 reask 走,不是写死的 2)",
      (j) => { j.attempts.push({ ...j.attempts[0], n: 2 }); },
      /reask=0 最多只可能有 1 次/, noReask);
  }
  /* ⑲ **这道闸有两个调用点。** 上面每一格走的都是 `runNode`(`checkReuse` 里那次调用);
        **对话回放走的是另一条** —— `replayTurn` 里那次。把后者删掉,上面十几格**一个都不会红**,
        而一段被改过的对话回执照样复用成功,页面会把篡改后的字节当成"当初第 n 次写下的东西"挂出来。
        ⚠️ 对话的逐次原件带 `.t-<key>` 那一段(否则两轮的第 1 次会写进同一个文件)。 */
  {
    const outDir = freshOut();
    const conv = { id: "chat", agent: "omp", cwd: REPO, outDir };
    const once = (extra) => withBridge(async (b) => {
      await b.conversation({ ...conv, ...extra }, async (turn) => {
        await turn({ key: "draft", prompt: "唯一串-epsilon", timeoutMs: 30000 });
      });
    }, { viz: true, outDir });
    const restore = envFor("okturn");
    let err = null;
    try {
      await once({});
      fs.appendFileSync(path.join(outDir, "nodes", "chat.t-draft.a1.md"), "\n悄悄加一句\n", "utf8");
      await once({ reuseIfSame: true });
    } catch (e) { err = e; } finally { restore(); }
    ok("V6c ★ 对话回放这条路上,改过的审计原件同样被拒(闸的**第二个**调用点)",
      /第 1 次尝试的审计原件内容与回执记录的不一致/.test(err?.message || ""), err?.message?.slice(0, 220));
    ok("V6c 报的是回放那条路的话术(说得出是第几轮、哪个 key)",
      /回放不匹配[\s\S]{0,24}第 1 轮[\s\S]{0,24}draft/.test(err?.message || ""), err?.message?.slice(0, 160));
  }
  /* ⑩ **只删「末次(accepted)」那一项的 `artifactPath`,留着前一次 rejected 的。**
     ⚠️ 这一格是上一版最危险的漏网:缺路径本身是允许的(复制当时可能真的失败),
        所以闸门放行;而归档器早先的回退条件是「**一次都没归档到**才退回整轮产出」——
        既然 rejected 那次归档到了,回退就整个不跑,于是"该轮最后一份成功复制的产出"
        选中了**被打回的那一稿**,它一路升成轮产出与顶层交付物,
        不变式③按同一口径选中同一项 —— **两边一起假绿**。
        **一个字段被删掉,一份被否决的草稿就成了交付物。**
     ⚠️ 所以这里要考的不是"拒没拒",而是**最终交付物到底是谁**。 */
  {
    const { outDir, err } = await mk((outDir) => {
      const rp = path.join(outDir, "nodes", "audit.receipt.json");
      const j = JSON.parse(fs.readFileSync(rp, "utf8"));
      const last = j.attempts[j.attempts.length - 1];
      delete last.artifactPath; delete last.artifactSha256;      // 只动末次
      fs.writeFileSync(rp, JSON.stringify(j, null, 2), "utf8");
    });
    ok("V6c 只删末次的路径 → 不拒(缺路径可能是当时复制失败)", err === null, err?.message?.slice(0, 160));
    const runsRoot = path.join(outDir, "nodes", ".runs");
    const ids = fs.readdirSync(runsRoot)
      .map((id) => ({ id, m: fs.statSync(path.join(runsRoot, id)).mtimeMs })).sort((a, b) => b.m - a.m);
    const lines3 = fs.readFileSync(path.join(runsRoot, ids[0].id, "transcript.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const st3 = evs(lines3, "node:settled")[0]?.payload;
    const t3 = st3?.turns?.[0];
    const bodyOf = (a) => (a?.ref && has(outDir, a.ref) ? fs.readFileSync(path.join(outDir, a.ref), "utf8") : "");
    ok("V6c ★ 该轮产出**不是**被打回那一稿(REASK_BAD_1 绝不能成为交付物)",
      !/REASK_BAD_1/.test(bodyOf(t3?.output)), bodyOf(t3?.output).slice(0, 60));
    ok("V6c ★ 顶层交付物同样不是被打回那一稿",
      !/REASK_BAD_1/.test(bodyOf(st3?.artifact)), bodyOf(st3?.artifact).slice(0, 60));
    ok("V6c ★ 交付物就是被采纳的那一份(整轮产出退回来、挂在末次名下)",
      /REASK_GOOD_/.test(bodyOf(st3?.artifact)), bodyOf(st3?.artifact).slice(0, 60));
    const lastAtt = (t3?.attempts || [])[(t3?.attempts || []).length - 1];
    ok("V6c ★ 而且它挂在**末次**名下,不是挂到被打回那次头上",
      lastAtt?.status === "accepted" && lastAtt?.output?.state === "present" &&
      lastAtt.output.sha256 === t3?.output?.sha256, JSON.stringify(lastAtt?.output));
  }
  // ⑨ attempts 整个被删空
  {
    const { err } = await mk((outDir) => {
      const rp = path.join(outDir, "nodes", "audit.receipt.json");
      const j = JSON.parse(fs.readFileSync(rp, "utf8"));
      j.attempts = [];
      fs.writeFileSync(rp, JSON.stringify(j, null, 2), "utf8");
    });
    ok("V6c ★ attempts 被清空 → 拒(v2 的每一轮至少有一次尝试)",
      /没有 attempts\[\]/.test(err?.message || ""), err?.message?.slice(0, 200));
  }
  // ⑤ 记了路径却没有合法指纹 —— **不许静默跳过校验**(这个坑本仓踩过三次)
  {
    const { err } = await mk((outDir) => {
      const rp = path.join(outDir, "nodes", "audit.receipt.json");
      const j = JSON.parse(fs.readFileSync(rp, "utf8"));
      delete j.attempts[0].artifactSha256;
      fs.writeFileSync(rp, JSON.stringify(j, null, 2), "utf8");
    });
    ok("V6c ★ 有路径没指纹 → 拒(字段缺失不许变成「跳过校验」)",
      /第 1 次尝试记了原件路径却没有合法的内容指纹/.test(err?.message || ""), err?.message?.slice(0, 200));
  }
  /* ⑥ **路径字段整个不见了**。
     ⚠️ 这一格早先写的是「当初就没留原件 → 放行(那是当时的选择,不是故障)」——**总结错了方向**:
        v2 的逐次审计原件与 viz 开关**无关**(见 `attemptArtifactPathFor`),v1 又已经被版本闸拒掉,
        所以「当初没开 viz 所以没有原件」这个理由在 v2 里根本不成立。真正会留下无路径项的
        只有**当时那次复制失败**;而「复制当时失败」与「事后把证据字段删掉」在回执里**长得一模一样**,
        现有结构没有字段能区分,所以这里拒不了。
     ⚠️ 但后果是**有界的**,这才是该考的东西:那一项被投影成 `fingerprint-only`,
        页面**拿不到任何字节** —— 删字段能让证据**消失**,不能让证据**变假**。 */
  {
    const { outDir, err } = await mk((outDir) => {
      const rp = path.join(outDir, "nodes", "audit.receipt.json");
      const j = JSON.parse(fs.readFileSync(rp, "utf8"));
      for (const a of j.attempts) { delete a.artifactPath; delete a.artifactSha256; }
      fs.writeFileSync(rp, JSON.stringify(j, null, 2), "utf8");
      fs.rmSync(path.join(outDir, "nodes", "audit.a1.md"), { force: true });
    });
    ok("V6c 路径字段没了 → 拒不了(结构上区分不出「当时复制失败」与「事后删证据」)",
      err === null, err?.message?.slice(0, 160));
    // 关键是**它拿不到字节**:这一次的归档里不许出现任何冒充审计原件的东西。
    const runsRoot = path.join(outDir, "nodes", ".runs");
    const ids = fs.readdirSync(runsRoot)
      .map((id) => ({ id, m: fs.statSync(path.join(runsRoot, id)).mtimeMs })).sort((a, b) => b.m - a.m);
    const lines2 = fs.readFileSync(path.join(runsRoot, ids[0].id, "transcript.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const st2 = evs(lines2, "node:settled")[0]?.payload;
    const t2 = st2?.turns?.[0];
    const outs = (t2?.attempts || []).map((x) => x.output);
    /* ⚠️ **这里的正确期望不是"每一次都拿不到字节"。** 逐次原件的字段被删光之后,
          归档器会退回**该轮那一份整轮产出**(`tr.artifactPath`)—— 而**那一份是被闸验过的**
          (路径是本次算出来的、sha 与回执逐字节对上),并且它本来就是**被采纳那一次**写下的
          同一段字节。所以把它挂在最后那一次名下**是真话**,不是伪造。
       ⚠️ 真正该守住的是这两条:
          ① **被打回的那一次**(#1)拿不到字节 —— 它那份独立证据确实消失了;
          ② 最后那一次挂的 ref **就是该轮产出那一份**,不是某个没验过的旁路文件。 */
    ok("V6c ★ 被打回那次(#1)的独立证据消失了(删字段能让证据消失)",
      outs[0]?.state !== "present", JSON.stringify(outs[0]));
    ok("V6c ★ 最后那次挂的是**被验过的那份整轮产出**,不是没验过的旁路文件(证据不会变假)",
      !!outs[outs.length - 1]?.ref && outs[outs.length - 1].ref === t2?.output?.ref &&
      outs[outs.length - 1].sha256 === t2?.output?.sha256,
      JSON.stringify([outs[outs.length - 1], t2?.output]));
  }
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

  /* ★ 归档区**就在磁盘上,谁都能改**。上面那两条只证明"没人改的时候对得上",
        而页面那套防篡改全押在"文件被改了,这个头会跟着变"上。
        ⚠️ 判据必须是**改完之后头也变了**:如果服务端偷懒把事件里记的 sha 回显出来,
           上面两条照样全绿,而页面永远发现不了任何一次篡改 —— 一个永不报警的警报器。
        ⚠️ 而且**不许因此判 4xx/5xx**:文件确实在、也确实读到了,拒绝服务只会让人以为文件丢了。 */
  {
    const p = path.join(outDir, ref);
    const before = fs.readFileSync(p);
    fs.writeFileSync(p, Buffer.concat([before, Buffer.from("\n(有人动过这个文件)\n", "utf8")]));
    const tampered = await httpReq(`${url}file?ref=${encodeURIComponent(ref)}`);
    fs.writeFileSync(p, before);                    // 立刻改回去,别影响后面的断言
    ok("V8 ★ 文件被改过之后照样 200(不许因此拒绝服务)", tampered.status === 200, String(tampered.status));
    ok("V8 ★ 而且指纹头**变了** —— 它算的是磁盘上这一份,不是事件里记的那个数",
      tampered.headers["x-graph-sha256"] !== st.artifact.sha256, tampered.headers["x-graph-sha256"]);
    ok("V8 ★ 新指纹与新字节对得上",
      tampered.headers["x-graph-sha256"] === crypto.createHash("sha256").update(tampered.body).digest("hex"));
    ok("V8 Content-Length 跟着这次的响应体走",
      Number(tampered.headers["content-length"]) === tampered.body.length);
  }

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
 * V9 强杀路径:transcript 里**没有** run:final,管道 EOF ⟹ 服务端必须发 owner-lost。
 *
 * 为什么单独造场景而不是复用前面那些:前面每一条都是有序收场,transcript 里都有 run:final,
 * 那一档由 transcript 自己说了算。**只有拿不到 run:final 时,页面才无从判断
 * 「还在跑、暂时没消息」与「跑完了、就是没有 final」** —— 这一帧就是为那个岔口存在的。
 * 不测它,no_finish 与 log_broken_unknown 两档在页面上永远走不到。
 */
async function v9_owner_ended() {
  console.log("\n[V9] 强杀(无 run:final)→ control{owner-lost}");
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
  ok("V9 owner 还在时不发 owner-lost",
    !before.frames.some((f) => f.event === "control" && /owner-lost/.test(f.data || "")));

  // 管道 EOF = owner 结束。**这是判活的唯一合同。**
  child.disconnect();
  await new Promise((r) => setTimeout(r, 1200));

  const after = await sseCollect(url, 2000);
  const ctrl = after.frames.filter((f) => f.event === "control").map((f) => JSON.parse(f.data));
  ok("V9 ★ 管道 EOF 之后必须发 owner-lost", ctrl.some((c) => c.kind === "owner-lost"),
    JSON.stringify(ctrl));
  ok("V9 没有 run:final 时也不伪造 owner-final", !ctrl.some((c) => c.kind === "owner-final"));
  // ★ 两者**互斥**:同时下发会让消费方把"受控结束"与"owner 也丢了"归并成一句话。
  ok("V9 ★ owner-lost 与 owner-final 互斥",
    !(ctrl.some((c) => c.kind === "owner-lost") && ctrl.some((c) => c.kind === "owner-final")));
  ok("V9 owner-lost 只有 kind 一个键",
    ctrl.filter((c) => c.kind === "owner-lost").every((c) => Object.keys(c).length === 1), JSON.stringify(ctrl));
  ok("V9 事件照常回放(结束不等于把已有的记录丢掉)",
    after.frames.filter((f) => f.event === "tx").length === 2);

  try { child.kill(); } catch { /* 已经退了 */ }
}

/* ============================================================ */
/**
 * V10 大 transcript 回放期间,服务端仍然活着。
 *
 * ⚠️ 这一条是为了钉死「异步流式回放」这四个字。
 * **没有它,一个 readFileSync 实现能过全部其它用例** —— 小样例下同步读也就几毫秒,看不出差别;
 * 真到两小时的运行上,页面一连上去整个服务就僵住,而日志上一切正常。
 *
 * 判据刻意**不用时间阈值**(会在负载机器上抖),而用**顺序**:
 * 回放还没放完的时候,另一个 HTTP 请求就该已经拿到响应了。
 * 同步读做不到这件事 —— 它要等整份文件解析完才回到事件循环。
 */
async function v10_big_replay() {
  console.log("\n[V10] 两万条回放期间,另一个请求照样被及时响应");
  const outDir = freshOut();
  const graphId = "gr-v10";
  const root = path.join(outDir, "nodes", ".runs", graphId);
  fs.mkdirSync(root, { recursive: true });

  const N = 20001;   // 比「两万」多一条 —— 别让实现刚好按整数边界截断
  const mk = (seq, event, payload) =>
    JSON.stringify({ v: 1, seq, ts: 1000 + seq, graphId, event, payload }) + "\n";
  const out = fs.createWriteStream(path.join(root, "transcript.jsonl"));
  out.write(mk(0, "run:started", { outDir, maxConcurrent: 4 }));
  out.write(mk(1, "node:observed", { nodeSeq: 0, id: "big", agent: "omp", access: "read", cwd: REPO,
    model: null, effort: null, spec: { state: "not-applicable" }, prompt: { state: "not-applicable" },
    role: { state: "not-applicable" }, declaredDeps: [], inferredDeps: [], inferredDepsTruncated: false }));
  out.write(mk(2, "node:turn", { nodeSeq: 0, turnKey: "main", input: { state: "not-applicable" },
    timeoutMs: 600000, reask: 1, inferredDeps: [], inferredDepsTruncated: false }));
  out.write(mk(3, "node:started", { nodeSeq: 0, turnKey: "main", queuedMs: 10 }));
  for (let i = 4; i < N; i++) {
    // 带中文 —— 多字节字符是「分块读之后拼串」最容易踩坏的地方。
    out.write(mk(i, "node:progress", { nodeSeq: 0, turnKey: "main", status: "running",
      charCount: i, tail: "第 " + i + " 段:正在读 src/transport/sse.ts 与它的三处调用点" }));
  }
  await new Promise((r) => out.end(r));

  const { fork } = await import("node:child_process");
  const serve = path.join(REPO, "skills", "agent-bridge-graph", "viz", "serve.mjs");
  const child = fork(serve, [], { stdio: ["ignore", "ignore", "inherit", "ipc"],
    env: { ...process.env, VIZ_OUT_DIR: outDir, VIZ_GRAPH_ID: graphId, VIZ_PORT: "0" }, windowsHide: true });
  const url = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("viewer 没报出端口")), 15000);
    child.once("exit", (c) => { clearTimeout(t); reject(new Error("viewer 提前退出 " + c)); });
    child.on("message", (m) => { if (m && m.kind === "viz-listening") { clearTimeout(t); resolve(m.url); } });
  });

  let txCount = 0, firstTxAt = 0, lastTxAt = 0, badChar = false;
  let sideDoneAt = 0, txAtSide = 0;
  const started = Date.now();
  const done = new Promise((resolve) => {
    let buf = "";
    const req = http.get(url + "events", (res) => {
      res.setEncoding("utf8");
      res.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const raw = buf.slice(0, i); buf = buf.slice(i + 2);
          if (!raw.startsWith("event: tx")) continue;
          txCount++; lastTxAt = Date.now(); if (!firstTxAt) firstTxAt = lastTxAt;
          if (sideDoneAt && !txAtSide) txAtSide = txCount;   // 旁路响应落地那一刻,已经放了多少帧
          // U+FFFD 出现 = 某一次分块把一个多字节字符劈成了两半
          if (raw.indexOf("�") !== -1) badChar = true;
        }
      });
    });
    req.on("error", () => {});
    setTimeout(() => { try { req.destroy(); } catch { /* 已经断了 */ } resolve(); }, 20000);
  });

  // 等第一帧到手(说明回放确实开始了)再发旁路请求 —— 否则它可能抢在回放开始之前完成,什么都测不到。
  await new Promise((r) => {
    const w = setInterval(() => { if (firstTxAt) { clearInterval(w); r(); } }, 5);
    setTimeout(() => { clearInterval(w); r(); }, 5000);
  });
  const side = await httpReq(url);
  const sideAt = Date.now();
  sideDoneAt = sideAt;
  await done;

  ok("V10 两万条一条不少地回放到位", txCount === N, txCount + " vs " + N);
  ok("V10 旁路请求成功", side.status === 200, String(side.status));
  ok("V10 ★ 旁路请求在回放**放完之前**就拿到了响应(同步整文件读做不到)",
    sideAt < lastTxAt, "旁路 +" + (sideAt - started) + "ms,最后一帧 +" + (lastTxAt - started) + "ms");
  // ⚠️ 上面那条只差几十毫秒时会抖。**再加一条不看时钟的**:旁路响应落地时,
  //    后面还应该有相当一批帧没发出去。同步读的实现在这里必然是 0(它一帧都还没开始发)。
  ok("V10 ★ 旁路响应落地时,回放还剩一大截没发完",
    txAtSide > 0 && txCount - txAtSide > N / 4,
    "旁路时已发 " + txAtSide + " / " + txCount);
  ok("V10 ★ 多字节字符没被分块拼坏(没有 U+FFFD)", !badChar);
  try { child.kill(); } catch { /* 已经退了 */ }
}

/* ============================================================ */
/**
 * V11 viz 的产物不弄脏工作树。
 *
 * ⚠️ **必须在一个新建的临时 git 仓库里跑。** 本仓库的 .graph/ 早就写进 .gitignore 了,
 * 在这里跑这条断言**永远是绿的** —— 它测不到任何东西。
 * 合同是 EVENTS.md §10.9 第 1 条:**viewer 不写任何 pid / state 文件**,判活只有那条生命管道。
 */
async function v11_clean_tree() {
  console.log("\n[V11] viz 不往工作树里落任何东西");
  const repo = path.join(RUN_ROOT, "cleanrepo");
  fs.mkdirSync(repo, { recursive: true });
  const git = (...a) => spawnSync("git", a, { cwd: repo, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "README.md"), "# 干净仓库\n");
  git("add", "-A"); git("commit", "-qm", "init");
  ok("V11 起点是干净的", git("status", "--porcelain").stdout.trim() === "");

  // out-dir 放在**仓库外面** —— 这样"仓库里多出任何东西"就一定是别人漏下来的。
  const outDir = freshOut();
  const restore = envFor("okturn");
  try {
    await withBridge(async (b) => {
      await b.runNode({ id: "clean", agent: "omp", cwd: repo, outDir, prompt: "hi", timeoutMs: 30000 });
    }, { viz: true, outDir });
  } finally { restore(); }

  const dirty = git("status", "--porcelain").stdout.trim();
  ok("V11 ★ 跑完之后工作树仍然干净(viewer 不写 pid/state,桥也不往 cwd 落东西)",
    dirty === "", dirty.split("\n").slice(0, 6).join(" | "));
  const stray = fs.readdirSync(repo).filter((f) => f !== ".git" && f !== "README.md");
  ok("V11 ★ 目录里也没有未跟踪的残留", stray.length === 0, stray.join(", "));
}

/* ============================================================ */
/**
 * write 节点在 wire 上的样子。**这一段此前一条断言都没有** —— worktree 那套回归不开 viz,
 * 于是「顶层 `diffRef`」与「`workspaceSummary` 六键」两处修复只被我自己手搓的样例考过,
 * 那是同源自证。这里用真生产者跑一遍。
 *
 * 两个节点各考一件事(read 节点那两条在 V1 —— `writeturn` 是进程级模式,
 * 让只读节点也跑它就会往主工作区写文件,把干净基线闸踩爆):
 *   w1  正常 write   —— 归档回执里**顶层** diffRef 指向真文件;workspace 里 diffPath 换成 diffRef;
 *                       回执归档成功 ⇒ **不许**再内联一份 workspaceSummary(同一事实的第二个副本)
 *   w2  归档子目录被占 —— 回执归档失败 ⇒ 这时 workspaceSummary 才出现,且**六个键一个都不能少**
 */
async function v12_write() {
  console.log("\n[V12] write 节点:顶层 diffRef 的传递闭包 + workspaceSummary 的出现条件");
  const repo = path.join(RUN_ROOT, "writerepo");
  fs.mkdirSync(repo, { recursive: true });
  const git = (...a) => spawnSync("git", a, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t"); git("config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "README.md"), "base\n");
  git("add", "-A"); git("commit", "-qm", "init");

  const outDir = freshOut();
  const restore = envFor("writeturn");
  try {
    await withBridge(async (b) => {
      await b.runNode({ id: "w1", agent: "omp", cwd: repo, outDir, access: "write",
        prompt: "PROMPT_V12", timeoutMs: 30000 });
      /* ⚠️ 第三个节点的归档子目录**被一个文件占住** —— 于是 `ensureDir` 失败、
            该节点这一次本来要归档的每一样都是 `archive-root-failed`(含回执本身)。
            这是唯一能确定性地把"回执没归档成功"那条路走出来的办法;
            graphId 是运行时才有的,所以要等前面的节点把它露出来。 */
      const gid = fs.readdirSync(path.join(outDir, "nodes", ".runs"))[0];
      fs.writeFileSync(path.join(outDir, "nodes", ".runs", gid, "1-w2"), "占住这个名字\n");
      await b.runNode({ id: "w2", agent: "omp", cwd: repo, outDir, access: "write",
        prompt: "PROMPT_V12_BLOCKED", timeoutMs: 30000 });
    }, { viz: true, outDir });
  } finally { restore(); }

  const { lines, graphId } = checkInvariants("V12", outDir);
  const settledOf = (seq) => evs(lines, "node:settled").find((l) => l.payload.nodeSeq === seq)?.payload;

  /* ---- w1:正常 write ---- */
  const s1 = settledOf(0);
  ok("V12 w1 收在 ok 且是 write(有 outcome)", s1?.status === "ok" && !!s1?.outcome, JSON.stringify(s1?.outcome));
  ok("V12 w1 diff 归档成功", s1?.diff?.state === "present", JSON.stringify(s1?.diff));
  v12DeliveredDiff = s1?.diff ?? null;   // 给 V12b 当"非零"的对照,省一次 write 跑
  ok("V12 w1 回执归档成功", s1?.receipt?.state === "present", JSON.stringify(s1?.receipt));
  ok("V12 ★ 回执在的时候**不许**再内联 workspaceSummary / errorSummary(同一事实的第二个副本)",
    !("workspaceSummary" in (s1 || {})) && !("errorSummary" in (s1 || {})),
    JSON.stringify(Object.keys(s1 || {})));
  {
    const rj = JSON.parse(fs.readFileSync(path.join(outDir, s1.receipt.ref), "utf8"));
    ok("V12 ★ 归档回执有**顶层** diffRef(传递闭包;早先那道'原来有才写'的守卫让它永远不写)",
      typeof rj.diffRef === "string" && rj.diffRef.length > 0, JSON.stringify(rj.diffRef));
    ok("V12 ★ 顶层 diffRef 指向的文件真在归档里", !!rj.diffRef && has(outDir, rj.diffRef), rj.diffRef);
    ok("V12 ★ 顶层 diffRef 与事件里那份 diff 是同一份", rj.diffRef === s1.diff.ref,
      `${rj.diffRef} ≠ ${s1.diff.ref}`);
    ok("V12 ★ canonical 区的绝对路径已被抹掉(顶层没有 diffPath)", !("diffPath" in rj));
    ok("V12 ★ workspace 里也换成了 diffRef、diffPath 已删",
      typeof rj.workspace?.diffRef === "string" && !("diffPath" in (rj.workspace || {})),
      JSON.stringify(rj.workspace?.diffRef));
    ok("V12 归档回执里的产出路径也是 ref 不是绝对路径",
      typeof rj.artifactRef === "string" && !("artifactPath" in rj), JSON.stringify(rj.artifactRef));
  }

  /* ---- w2:回执没归档成功 ---- */
  const s3 = settledOf(1);
  ok("V12 w2 的归档子目录确实被占住了 → 回执 unavailable{archive-root-failed}",
    s3?.receipt?.state === "unavailable" && s3.receipt.code === "archive-root-failed",
    JSON.stringify(s3?.receipt));
  ok("V12 ★ 这时(且只有这时)才内联 workspaceSummary", !!s3?.workspaceSummary,
    JSON.stringify(Object.keys(s3 || {})));
  {
    const w = s3?.workspaceSummary || {};
    const KEYS = ["path", "branch", "baseCommit", "headCommit", "removed", "changesKnown"];
    ok("V12 ★ 六个键一个都不能少(缺席不许用来表达'拿不到')",
      KEYS.every((k) => k in w) && Object.keys(w).length === KEYS.length,
      JSON.stringify(Object.keys(w)));
    ok("V12 ★ path 是能照着去核对的真路径", typeof w.path === "string" && w.path.length > 0, String(w.path));
    ok("V12 ★ baseCommit 要么 40 位十六进制、要么 null —— **不许是空串**(空串过不了 hex40,整条记录会作废)",
      w.baseCommit === null || /^[0-9a-f]{40}$/.test(w.baseCommit), String(w.baseCommit));
    ok("V12 headCommit 同样口径",
      w.headCommit === null || /^[0-9a-f]{40}$/.test(w.headCommit), String(w.headCommit));
    ok("V12 removed / changesKnown 是布尔",
      typeof w.removed === "boolean" && typeof w.changesKnown === "boolean",
      `${w.removed} / ${w.changesKnown}`);
  }
  ok("V12 w2 的产出也一并 archive-root-failed(不是 source-missing —— 东西在,是这一层够不着)",
    s3?.artifact?.state === "unavailable" && s3.artifact.code === "archive-root-failed",
    JSON.stringify(s3?.artifact));
  ok("V12 ★ 归档失败**不改变节点结局** —— 它照样是 ok(归档是旁路,不是执行的一部分)",
    s3?.status === "ok", s3?.status);
  ok("V12 两个节点都有终态", !!s1 && !!s3);
  ok("V12 transcript 仍然只有一份", !!graphId);
}

/* ============================================================ */
/**
 * **空提交**:HEAD 往前走了,净改动却是零。
 *
 * ⚠️ 页面判「已交付,但这次提交没有净改动」的**唯一**依据是 `diff` 自己是零字节
 * (早先错用 `changesKnown`,那个键只表示"git 探测跑成了")。
 * 所以这里要在**生产者这一侧**坐实:这个形状真的存在、真的是 `delivered`、
 * 而且它的 diff 真的是一份 `present` 的**零字节**资产 —— 否则页面那条判据
 * 就只被我手搓的冻结样例考过,是同源自证。
 *
 * ⚠️ 它**不是** `no-changes`:那一档要求 HEAD 也没动。两者在页面上是两段不同的话。
 */
async function v12b_empty_commit() {
  console.log("\n[V12b] 空提交:delivered + 零字节 diff(netEmpty 的唯一判据)");
  const repo = path.join(RUN_ROOT, "emptyrepo");
  fs.mkdirSync(repo, { recursive: true });
  const git = (...a) => spawnSync("git", a, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t"); git("config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "README.md"), "base\n");
  git("add", "-A"); git("commit", "-qm", "init");

  const outDir = freshOut();
  const restore = envFor("writeturn-emptycommit");
  try {
    await withBridge(async (b) => {
      await b.runNode({ id: "empty", agent: "omp", cwd: repo, outDir, access: "write",
        prompt: "PROMPT_EMPTY", timeoutMs: 30000 });
    }, { viz: true, outDir });
  } finally { restore(); }

  const { lines } = checkInvariants("V12b", outDir);
  const st = evs(lines, "node:settled")[0]?.payload;
  ok("V12b outcome 是 delivered(HEAD 动了 ⇒ 不是 no-changes)",
    st?.outcome === "delivered", JSON.stringify(st?.outcome));
  ok("V12b ★ diff 是一份 present 的**零字节**资产 —— 页面那条判据要的就是它",
    st?.diff?.state === "present" && st.diff.byteCount === 0, JSON.stringify(st?.diff));
  ok("V12b 零字节也照样有指纹(空文件的 sha256 是良定义的,不许因此判成损坏)",
    /^[0-9a-f]{64}$/.test(st?.diff?.sha256 || ""), st?.diff?.sha256);
  ok("V12b ★ 归档里那份 diff 文件真的在、真的是 0 字节",
    !!st?.diff?.ref && has(outDir, st.diff.ref) &&
    fs.statSync(path.join(outDir, st.diff.ref)).size === 0, st?.diff?.ref);
  /* ⚠️ 反向:一次**改了东西**的正常交付,diff 必须非零 —— 否则上面那条形同虚设
        (两种情况长一样的话,页面拿什么区分"净改动为零"和"正常交付"?)。 */
  ok("V12b ★ 对照:V12 那次正常交付的 diff 是非零字节", (() => {
    const d = v12DeliveredDiff;
    return !!d && d.state === "present" && d.byteCount > 0;
  })(), JSON.stringify(v12DeliveredDiff));
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
  await v6b_reuse_reask();
  await v6c_attempt_tamper();
  await v7_zero_turn();
  await v8_dataplane();
  await v9_owner_ended();
  await v10_big_replay();
  await v11_clean_tree();
  await v12_write();
  await v12b_empty_commit();
  console.log(`\n${"=".repeat(56)}`);
  console.log(`  graph-viz: ${pass} passed, ${fail} failed`);
  console.log(`${"=".repeat(56)}\n`);
  try { fs.rmSync(RUN_ROOT, { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("[harness] 自己炸了:", e); process.exit(1); });
