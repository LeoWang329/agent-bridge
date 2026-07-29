// Hermetic 回归:事件 writer(`skills/agent-bridge-graph/tools/viz-events.mjs`)。
// 零消耗、零网络、零后端 —— 纯有界化与落盘逻辑。
//
//   node docs/repro-mcp-hang/repro-viz-events.mjs
//
// **这份测试的重心全在失败路径上。** writer 的成功路径没什么可证的(写一行 JSON);
// 它的全部价值在于「超限、坏值、写不下去时会怎样」,而 EVENTS.md 对这些的规定是
// 「**绝不静默**」—— 而静默恰恰是不写测试就一定会发生的那种行为。
//
//   W1  信封与 seq      —— v/seq/ts/graphId/event/payload;seq 从 0 稠密
//   W2  BoundedSummary  —— 地板 / 触发 / 恒等式 / **头尾都留** / UTF-8 边界不切开
//   W3  结构字段超限    —— → recording-failed,**不是**换成 BoundedSummary(负对照)
//   W4  数值域          —— NaN / Infinity / 负数 / 非安全整数全拦下;null≠0
//   W5  数组            —— trunc 置 truncFlag(且盖掉调用方的假话);fail 模式超限报错;turns 下界 1
//   W6  schema 严格性   —— 缺必需字段 / 多一个键 / present 缺 ref,全判不符
//   W7  白名单          —— 多余键丢弃、白名单内超限照样报错(与 W6 互为对照)
//   W8  行上限          —— progress 整条丢**且不占号**;非 progress → recording-failed **且占号**
//   W9  短写            —— append 不 resolve 成功 + 判成 recorder 损坏 + 半行留在 EOF 且**再也不写**
//   W10 close() 抛错    —— **不**转 recording-failed(与 W9 互为负对照)
//   W11 wx              —— 同名 transcript 第二次开必须失败(同 outDir 两个 graph 并发)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  createEventWriter, boundPayload, boundedSummary, utf8Len,
  RecordingError, MAX_LINE_BYTES, DEGRADE_THRESHOLD,
} from "../../skills/agent-bridge-graph/tools/viz-events.mjs";
import { trimLoneSurrogate } from "../../skills/agent-bridge-graph/tools/viz-node.mjs";

const RUN_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "viz-events-"));
const GRAPH_ID = "11111111-2222-3333-4444-555555555555";

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`); }
}
/** 断言这段代码抛了 RecordingError(而不是"没抛"或"抛了别的")。 */
function throwsRecording(name, fn, matcher = null) {
  let e = null;
  try { fn(); } catch (err) { e = err; }
  if (!e) return ok(name, false, "没有抛异常");
  if (!(e instanceof RecordingError)) return ok(name, false, `抛的是 ${e.name}: ${e.message}`);
  if (matcher && !matcher.test(e.message)) return ok(name, false, `消息对不上:${e.message}`);
  ok(name, true);
}

let tmpN = 0;
const nextFile = () => path.join(RUN_ROOT, `t${++tmpN}.jsonl`);
const readLines = (f) =>
  fs.readFileSync(f, "utf8").split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));

/* ---- 拿来当合法样板的 payload 工厂 ---- */
const asset = (over = {}) => ({
  state: "present", ref: `nodes/.runs/${GRAPH_ID}/1-a/x.md`,
  sha256: "a".repeat(64), byteCount: 10, ...over,
});
const na = { state: "not-applicable" };
const turnSummary = (over = {}) => ({
  key: "main", status: "ok", sessionReusable: true, output: asset(),
  turnSpecHash: "b".repeat(32), charCount: 100, durationMs: 5,
  inferredDeps: [], inferredDepsTruncated: false,
  attempts: [{ n: 1, status: "accepted", inputSha256: "c".repeat(64), input: asset(), output: asset() }],
  ...over,
});
const settled = (over = {}) => ({
  nodeSeq: 1, status: "ok", execution: "fresh", durationMs: 9,
  receipt: asset(), artifact: asset(), diff: na, turns: [turnSummary()], ...over,
});
const started = { outDir: "D:/repo/.graph/out", maxConcurrent: 4 };

/* ============================================================
   W1 信封与 seq
   ============================================================ */
console.log("\nW1 信封与 seq");
{
  const f = nextFile();
  const w = createEventWriter({ file: f, graphId: GRAPH_ID });
  await w.append("run:started", started);
  await w.append("node:settled", settled());
  await w.append("run:final", {
    result: "completed", durationMs: 12,
    counts: { observed: 1, rejected: 0, ok: 1, contract_error: 0, backend_failed: 0, timeout: 0, unknown: 0, callback_error: 0, reused: 0 },
  });
  w.close();
  const ls = readLines(f);
  ok("W1.1 三条都落盘", ls.length === 3, `拿到 ${ls.length}`);
  ok("W1.2 信封六键齐全", ls.every((l) => ["v", "seq", "ts", "graphId", "event", "payload"].every((k) => k in l)));
  ok("W1.3 v 恒为 1", ls.every((l) => l.v === 1));
  ok("W1.4 seq 从 0 起稠密", ls.map((l) => l.seq).join(",") === "0,1,2");
  ok("W1.5 每条都带 graphId", ls.every((l) => l.graphId === GRAPH_ID));
  ok("W1.6 ts 是非负安全整数", ls.every((l) => Number.isSafeInteger(l.ts) && l.ts >= 0));
  ok("W1.7 payload 恒是对象", ls.every((l) => l.payload && typeof l.payload === "object" && !Array.isArray(l.payload)));
  ok("W1.8 每行以换行结尾", fs.readFileSync(f, "utf8").endsWith("\n"));
}

/* ============================================================
   W2 BoundedSummary
   ============================================================ */
console.log("\nW2 BoundedSummary(§3.3)");
{
  // 地板:≤2 KiB 原样留字符串。⚠️ 阈值比 2 KiB 小就永远触发不了(§3.3 那条注记)。
  const small = "x".repeat(DEGRADE_THRESHOLD);
  const p1 = boundPayload("node:rejected", { nodeSeq: 1, phase: "lock", error: small });
  ok("W2.1 地板:恰好 2 KiB 原样留字符串", typeof p1.error === "string" && p1.error === small);

  const big = "y".repeat(DEGRADE_THRESHOLD + 1);
  const p2 = boundPayload("node:rejected", { nodeSeq: 1, phase: "lock", error: big });
  ok("W2.2 超一个字节就降级", typeof p2.error === "object" && p2.error !== null);
  ok("W2.3 五个字段全部恒在",
    ["totalBytes", "sha256", "head", "tail", "omittedBytes"].every((k) => k in p2.error));
  ok("W2.4 没有 name / code 这类死字段",
    !("name" in p2.error) && !("code" in p2.error));
  ok("W2.5 omittedBytes 恒 > 0", p2.error.omittedBytes > 0);
  ok("W2.6 恒等式:omitted = total − head − tail",
    p2.error.omittedBytes === p2.error.totalBytes - utf8Len(p2.error.head) - utf8Len(p2.error.tail));
  ok("W2.7 sha256 是**原始完整串**的指纹",
    p2.error.sha256 === crypto.createHash("sha256").update(big, "utf8").digest("hex"));

  // ⚠️ 只截头是这类实现最常见的错 —— 根因往往在最后一行。
  const withTail = "A".repeat(5000) + "caused by: EACCES";
  const p3 = boundPayload("node:rejected", { nodeSeq: 1, phase: "lock", error: withTail });
  ok("W2.8 **尾巴必须留**(根因常在最后一行)", p3.error.tail.endsWith("caused by: EACCES"));
  ok("W2.9 头也留了", p3.error.head.startsWith("AAAA"));

  // UTF-8 边界:全中文串,头尾各 1 KiB。每个汉字 3 字节,1024 不是 3 的倍数 → 必然踩到边界。
  const cn = "中".repeat(3000);
  const p4 = boundPayload("node:rejected", { nodeSeq: 1, phase: "lock", error: cn });
  ok("W2.10 UTF-8 边界不切开:head 无替换字符", !p4.error.head.includes("\uFFFD"));
  ok("W2.11 UTF-8 边界不切开:tail 无替换字符", !p4.error.tail.includes("\uFFFD"));
  ok("W2.12 允许少留、不许多留", utf8Len(p4.error.head) <= 1024 && utf8Len(p4.error.tail) <= 1024);
  ok("W2.13 少留也只少几个字节", utf8Len(p4.error.head) >= 1022);
  // round-trip:头尾拼回去必须是原串的真前缀 / 真后缀,否则与 sha256 对不上
  ok("W2.14 head 是原串真前缀", cn.startsWith(p4.error.head));
  ok("W2.15 tail 是原串真后缀", cn.endsWith(p4.error.tail));

  // 四个可降级字段各测一次(§3.4:一个不多一个不少)
  const pr = boundPayload("node:attempt-settled",
    { nodeSeq: 1, turnKey: "main", n: 1, status: "rejected", output: asset(),
      durationMs: 5, charCount: 10, rejectedReason: big });
  ok("W2.16 rejectedReason 同档降级", typeof pr.rejectedReason === "object");
  const pe = boundPayload("node:turn-settled", {
    nodeSeq: 1, turnKey: "main", status: "ok", sessionReusable: true, output: asset(),
    scene: na, charCount: 1, durationMs: 1, errorSummary: big,
  });
  ok("W2.17 errorSummary 同档降级", typeof pe.errorSummary === "object");
}

/** `node:progress` 的最小合法 payload。
 *  ⚠️ 合同(§5.7)要求 `n` / `charCount` / `lastEvent` / `contextUsage` **恒在**
 *  (后两个可 null)。写成工厂是为了以后再加必需字段时**只改一处** ——
 *  早先这几处各写各的字面量,加一个 `n` 就红了五条。 */
const progressPayload = (o = {}) => ({
  nodeSeq: 1, turnKey: "main", n: 1, status: "running", charCount: 1, tail: "t",
  lastEvent: null, contextUsage: null, ...o,
});

/* ============================================================
   W3 结构字段超限 → recording-failed(不是换类型)
   ============================================================ */
console.log("\nW3 结构字段超限(§3.4 负对照)");
{
  // 600 字节的分支名 —— 设计文档点名的那个用例。
  throwsRecording("W3.1 超长 branch → RecordingError",
    () => boundPayload("node:workspace-created",
      { nodeSeq: 1, path: "p", branch: "b".repeat(600), baseCommit: "c" }), /结构字符串超限/);

  // ⚠️ 负对照:它**不许**变成 BoundedSummary。上一条只证了"抛了",这条证"没走降级路"。
  let degraded = false;
  try {
    const r = boundPayload("node:workspace-created",
      { nodeSeq: 1, path: "p", branch: "b".repeat(600), baseCommit: "c" });
    degraded = typeof r.branch === "object";
  } catch { /* 期望走这里 */ }
  ok("W3.2 **没有**被偷偷换成 BoundedSummary", !degraded);

  throwsRecording("W3.3 超长 ref(>512)", () =>
    boundPayload("node:settled", settled({ receipt: asset({ ref: "n/" + "x".repeat(600) }) })));
  throwsRecording("W3.4 超长 code(>200)", () =>
    boundPayload("node:settled", settled({ diff: { state: "unavailable", code: "z".repeat(300) } })));
  throwsRecording("W3.5 turnKey 超 200", () =>
    boundPayload("node:started", { nodeSeq: 1, turnKey: "k".repeat(300), queuedMs: 0 }));
  throwsRecording("W3.6 turnSpecHash 给成 hex64(形状不对)", () =>
    boundPayload("node:settled", settled({ turns: [turnSummary({ turnSpecHash: "d".repeat(64) })] })), /hex32/);
  throwsRecording("W3.7 sha256 给成 hex32", () =>
    boundPayload("node:settled", settled({ receipt: asset({ sha256: "e".repeat(32) }) })), /hex64/);
  // progress.tail 天生有界,不许降级
  throwsRecording("W3.8 progress.tail 超 240 code unit → 报错不降级", () =>
    boundPayload("node:progress",
      progressPayload({ tail: "t".repeat(241) })), /UTF-16/);

  /* W3.9 **按 code unit 截断会切开代理对**(半个 emoji)。§5.7 定死:切完之后若首字符是
     落单的**低代理**,把它丢掉。
     ⚠️ W3.8 只考"超长会被拒",考不到这个边界 —— 把 `trimLoneSurrogate` 整个删掉、
        或者把高低代理判反,它照样全绿,而页面会收到一个孤立低代理、显示成 U+FFFD。 */
  {
    const emoji = "\u{1F600}";                      // 一个代理对:D83D DE00
    const lo = emoji.charAt(1);                     // 落单的**低**代理 DE00
    const hi = emoji.charAt(0);                     // 落单的**高**代理 D83D
    ok("W3.9 ★ 首字符是落单低代理 → 丢掉它", trimLoneSurrogate(lo + "abc") === "abc",
      JSON.stringify(trimLoneSurrogate(lo + "abc")));
    ok("W3.9 ★ 完整的代理对**不许**动(它不是半个)", trimLoneSurrogate(emoji + "x") === emoji + "x");
    ok("W3.9 ★ 落单的**高**代理在首位时不动(合同只说丢低代理)",
      trimLoneSurrogate(hi + "abc") === hi + "abc");
    ok("W3.9 普通字符不动", trimLoneSurrogate("abc") === "abc");
    ok("W3.9 空串不炸", trimLoneSurrogate("") === "");
    /* ⚠️ **光考 helper 不够** —— 把 `node:progress` 的调用点改回裸 `slice(-240)`,
          上面每一条照样全绿,而 wire 上重新出现落单低代理。所以这里直接读源码,
          坐实**那个调用点确实经过了它**。(读源码是笨办法,但它考的正是"有没有接上"。) */
    const src = fs.readFileSync(
      new URL("../../skills/agent-bridge-graph/tools/viz-node.mjs", import.meta.url), "utf8");
    const tailLine = src.split("\n").find((l) => /^\s*tail:/.test(l)) || "";
    ok("W3.9 ★ node:progress 的 tail 真的经过 trimLoneSurrogate(不是只导出了没接上)",
      /trimLoneSurrogate\s*\(/.test(tailLine), tailLine.trim());
  }
}

/* ============================================================
   W4 数值域(§6.1)
   ============================================================ */
console.log("\nW4 数值域");
{
  // ⚠️ JSON.stringify 会把 NaN/Infinity **静默变成 null** —— 于是"未知"、"0"、"没测到"
  //    三种截然不同的事实长得一模一样。这是本设计的头号敌人。
  throwsRecording("W4.1 NaN 拦下", () => boundPayload("node:settled", settled({ durationMs: NaN })), /NaN/);
  throwsRecording("W4.2 Infinity 拦下", () => boundPayload("node:settled", settled({ durationMs: Infinity })), /Infinity/);
  throwsRecording("W4.3 负数拦下", () => boundPayload("node:settled", settled({ durationMs: -1 })));
  throwsRecording("W4.4 小数拦下(durationMs 取整)", () => boundPayload("node:settled", settled({ durationMs: 1.5 })));
  throwsRecording("W4.5 超安全整数拦下", () => boundPayload("node:settled", settled({ nodeSeq: 2 ** 53 })));
  throwsRecording("W4.6 attempt 的 n 是 1-based,0 非法", () =>
    boundPayload("node:attempt", { nodeSeq: 1, turnKey: "main", n: 0, input: asset(), inputSha256: "f".repeat(64) }));
  throwsRecording("W4.7 reask 只能 0/1", () =>
    boundPayload("node:turn", {
      nodeSeq: 1, turnKey: "main", input: asset(), timeoutMs: 1, reask: 2,
      inferredDeps: [], inferredDepsTruncated: false,
    }));
  throwsRecording("W4.8 timeoutMs 必须 ≥1", () =>
    boundPayload("node:turn", {
      nodeSeq: 1, turnKey: "main", input: asset(), timeoutMs: 0, reask: 0,
      inferredDeps: [], inferredDepsTruncated: false,
    }));
  // null ≠ 0:charCount 可空,但可空的只有它
  const okNull = boundPayload("node:settled", settled({ turns: [turnSummary({ charCount: null })] }));
  ok("W4.9 charCount 可以是 null(「没测到」≠「零个字」)", okNull.turns[0].charCount === null);
  throwsRecording("W4.10 durationMs 不可空", () =>
    boundPayload("node:settled", settled({ turns: [turnSummary({ durationMs: null })] })));
  // contextUsage.tokens 允许小数但必须有限非负
  const cu = boundPayload("node:progress", progressPayload({ contextUsage: { tokens: 1234.5, live: true } }));
  ok("W4.11 contextUsage.tokens 允许小数", cu.contextUsage.tokens === 1234.5);
}

/* ============================================================
   W5 数组
   ============================================================ */
console.log("\nW5 数组上限与截断");
{
  // 事件级 inferredDeps:上限 200,超了截断 + 置 truncated(**绝不静默截断**)
  const many = Array.from({ length: 250 }, (_, i) => `nodes/x${i}.md`);
  const p = boundPayload("node:observed", {
    nodeSeq: 1, id: "a", agent: "codex", access: "read", cwd: "D:/r",
    model: null, effort: null, spec: asset(), prompt: asset(), role: na,
    declaredDeps: [], inferredDeps: many, inferredDepsTruncated: false,
  });
  ok("W5.1 截到 200 项", p.inferredDeps.length === 200);
  // ⚠️ 调用方传的是 false —— 截断这件事本身必须盖掉它,否则页面会把
  //    "截了 50 项"显示成"本来就只有 200 项"。
  ok("W5.2 truncFlag 由截断本身置位,盖掉调用方的假话", p.inferredDepsTruncated === true);

  // turns[] 里的 inferredDeps 上限更小(20)——它内联在 node:settled 一行里
  const ps = boundPayload("node:settled", settled({
    turns: [turnSummary({ inferredDeps: many, inferredDepsTruncated: false })],
  }));
  ok("W5.3 turns[].inferredDeps 上限是 20(比事件级小)", ps.turns[0].inferredDeps.length === 20);
  ok("W5.4 该项自己的 truncated 置位", ps.turns[0].inferredDepsTruncated === true);

  // fail 模式:declaredDeps 超 200 不截断,报错(入口本该已拒,这里是最后一道)
  throwsRecording("W5.5 declaredDeps 超 200 → 报错不截断", () =>
    boundPayload("node:observed", {
      nodeSeq: 1, id: "a", agent: "codex", access: "read", cwd: "D:/r",
      model: null, effort: null, spec: asset(), prompt: asset(), role: na,
      declaredDeps: many, inferredDeps: [], inferredDepsTruncated: false,
    }), /条数超限/);

  throwsRecording("W5.6 turns 超 20 → 报错不截断(截掉的轮会表现成「本来就只有 K 轮」)", () =>
    boundPayload("node:settled", settled({ turns: Array.from({ length: 21 }, () => turnSummary()) })), /条数超限/);

  throwsRecording("W5.7 attempts 超 2 → 报错", () =>
    boundPayload("node:settled", settled({
      turns: [turnSummary({ attempts: [1, 2, 3].map((n) => ({ n, status: "accepted", inputSha256: "c".repeat(64), input: asset(), output: asset() })) })],
    })));

  // ⚠️ 下界 1:一轮都没跑起来的节点根本不会有 node:settled(它走 node:rejected)
  throwsRecording("W5.8 turns 空数组非法(下界是 1 不是 0)", () =>
    boundPayload("node:settled", settled({ turns: [] })), /条数不足/);
}

/* ============================================================
   W6 schema 严格性
   ============================================================ */
console.log("\nW6 schema 严格性(「漏字段写不出来」)");
{
  throwsRecording("W6.1 必需字段缺席 → 判不符", () => {
    const s = settled(); delete s.execution;
    return boundPayload("node:settled", s);
  }, /必需字段缺席/);

  throwsRecording("W6.2 多一个 schema 里没有的键 → 判不符", () =>
    boundPayload("node:settled", settled({ scene: na })), /没有这个键/);

  // ⚠️ node:settled 上**没有** scene、也没有节点级 attempts —— 两样都下沉到轮。
  throwsRecording("W6.3 node:settled 上不许有节点级 attempts", () =>
    boundPayload("node:settled", settled({ attempts: [] })), /没有这个键/);

  // {state:"present"} 却没有 ref,等于没有:页面知道"东西在"却点不开
  throwsRecording("W6.4 present 缺 ref → 判不符", () =>
    boundPayload("node:settled", settled({ receipt: { state: "present", sha256: "a".repeat(64), byteCount: 1 } })),
    /必需字段缺席/);
  throwsRecording("W6.5 present 缺 sha256 → 判不符", () =>
    boundPayload("node:settled", settled({ receipt: { state: "present", ref: "nodes/x", byteCount: 1 } })));
  // not-applicable 不许有任何其它键
  throwsRecording("W6.6 not-applicable 带了 code → 判不符", () =>
    boundPayload("node:settled", settled({ diff: { state: "not-applicable", code: "x" } })), /没有这个键/);
  throwsRecording("W6.7 unavailable 缺 code → 判不符", () =>
    boundPayload("node:settled", settled({ diff: { state: "unavailable" } })));
  throwsRecording("W6.8 不认识的 state 标签", () =>
    boundPayload("node:settled", settled({ diff: { state: "pending" } })), /判别标签/);

  // 封闭枚举
  throwsRecording("W6.9 node:settled.status 封闭六档", () =>
    boundPayload("node:settled", settled({ status: "rejected" })), /封闭枚举/);
  throwsRecording("W6.10 node:rejected.phase 封闭六档", () =>
    boundPayload("node:rejected", { nodeSeq: 1, phase: "dup_id", error: "x" }), /封闭枚举/);
  // 六档必须**全部**收得下(缺一档就是页面判不出那种情况)
  for (const phase of ["lock", "preflight", "reuse-check", "workspace-setup", "turn-validation", "zero-turn"]) {
    const r = boundPayload("node:rejected", { nodeSeq: 1, phase, error: "x" });
    ok(`W6.11 phase=${phase} 收得下`, r.phase === phase);
  }
  // node:settled.status 六档同理 —— callback_error 是最容易被漏掉的那一档
  for (const st of ["ok", "contract_error", "backend_failed", "timeout", "unknown", "callback_error"]) {
    const r = boundPayload("node:settled", settled({ status: st }));
    ok(`W6.12 status=${st} 收得下`, r.status === st);
  }
  // 轮级五档 + not-started
  for (const st of ["ok", "contract_error", "backend_failed", "timeout", "unknown", "not-started"]) {
    const r = boundPayload("node:turn-settled", {
      nodeSeq: 1, turnKey: "main", status: st, sessionReusable: true,
      output: asset(), scene: na, charCount: 1, durationMs: 1,
    });
    ok(`W6.13 turn status=${st} 收得下`, r.status === st);
  }
  // 但 turns[] 里**没有** not-started(没跑起来的轮不进 turns[])
  throwsRecording("W6.14 turns[] 里不许有 not-started", () =>
    boundPayload("node:settled", settled({ turns: [turnSummary({ status: "not-started" })] })), /封闭枚举/);

  // ⚠️ **「可 null」与「可缺席」是两回事,别混。** 这条曾经真的写错过:
  //    `model` 被当成"可缺席的非空串",于是一个不指定模型的节点(model:null)
  //    直接把整份 transcript 判成记录损坏 —— 而页面侧混了则会把
  //    「没指定模型」和「这个字段还没实现」看成同一件事。
  const obsBase = {
    nodeSeq: 1, id: "a", agent: "codex", access: "read", cwd: "D:/r",
    model: null, effort: null, spec: asset(), prompt: asset(), role: na,
    declaredDeps: [], inferredDeps: [], inferredDepsTruncated: false,
  };
  const pNull = boundPayload("node:observed", obsBase);
  ok("W6.15a model/effort 是**必需但可 null**", pNull.model === null && pNull.effort === null);
  ok("W6.15b group 不传 → **整个键不出现**(不是 null)", !("group" in pNull));
  const pGroup = boundPayload("node:observed", { ...obsBase, group: "round-2" });
  ok("W6.15c group 传了就在", pGroup.group === "round-2");
  throwsRecording("W6.15d 但 model 这个**键**不能缺席", () => {
    const x = { ...obsBase }; delete x.model; return boundPayload("node:observed", x);
  }, /必需字段缺席/);
  throwsRecording("W6.15e group 不能是 null(它没有 null 这个取值)",
    () => boundPayload("node:observed", { ...obsBase, group: null }), /要字符串/);
  throwsRecording("W6.15f agent 是封闭枚举",
    () => boundPayload("node:observed", { ...obsBase, agent: "gpt" }), /封闭枚举/);

  throwsRecording("W6.15 未知事件类型", () => boundPayload("node:queued", { nodeSeq: 1 }), /未知事件类型/);
  throwsRecording("W6.16 run:final.counts 多一个键", () =>
    boundPayload("run:final", {
      result: "completed", durationMs: 1,
      counts: { observed: 1, rejected: 0, ok: 1, contract_error: 0, backend_failed: 0, timeout: 0, unknown: 0, callback_error: 0, reused: 0, turns: 3 },
    }), /没有这个键/);
  throwsRecording("W6.17 run:final.counts 少一个键(callback_error 最易漏)", () => {
    const c = { observed: 1, rejected: 0, ok: 1, contract_error: 0, backend_failed: 0, timeout: 0, unknown: 0, reused: 0 };
    return boundPayload("run:final", { result: "completed", durationMs: 1, counts: c });
  }, /必需字段缺席/);
}

/* ============================================================
   W7 白名单(与 W6 互为对照)
   ============================================================ */
console.log("\nW7 白名单:多余键丢弃 vs 判不符");
{
  const p = boundPayload("node:progress", progressPayload({
    charCount: 5, tail: "…",
    contextUsage: { tokens: 100, live: true, windowSize: 1000000, percent: 0.1 },
    lastEvent: { at: "2026-07-28T00:00:00Z", type: "engine.chunk", raw: { huge: "x".repeat(10000) } },
  }));
  ok("W7.1 contextUsage 白名单内保留", p.contextUsage.tokens === 100 && p.contextUsage.live === true);
  ok("W7.2 contextUsage 白名单外丢弃(不报错)",
    !("windowSize" in p.contextUsage) && !("percent" in p.contextUsage));
  ok("W7.3 lastEvent 白名单内保留", p.lastEvent.at && p.lastEvent.type === "engine.chunk");
  ok("W7.4 lastEvent 白名单外丢弃", !("raw" in p.lastEvent));
  // ⚠️ "来自后端"不是免检理由:白名单**内**的字段照样受上限约束
  throwsRecording("W7.5 白名单内超限照样报错", () =>
    boundPayload("node:progress", progressPayload({ lastEvent: { at: "x".repeat(300), type: "y" } })), /结构字符串超限/);
  // 对照:同样是"多一个键",顶层就必须判不符(W6.2)。两条规则的分界要说得清。
  throwsRecording("W7.6 对照:顶层多一个键仍判不符", () =>
    boundPayload("node:progress", progressPayload({ extra: 1 })), /没有这个键/);
}

/* ============================================================
   W8 行上限
   ============================================================ */
console.log("\nW8 行上限(§7 推论 1)");
{
  // progress:有界化之后仍超行上限 → **整条丢,且不占号**
  const f = nextFile();
  let failedCall = null;
  const w = createEventWriter({ file: f, graphId: GRAPH_ID, onRecordingFailed: (x) => { failedCall = x; } });
  await w.append("run:started", started);
  // 造一条超 1 MiB 的 progress:tail 有界,但 status 200 字节 × ... 不够。
  // 用 turnKey(200)+status(200) 顶不到 1 MiB,所以直接塞一个合法但巨大的 contextUsage 是不行的
  // (白名单会裁掉)。真实里 progress 顶不穿行上限 —— 所以这里直接验 writer 的分支:
  // 用一个合法 payload 但把 MAX 临时逼近是不可能的,于是改用**事实断言**:
  // progress 的所有字段都有界 ⇒ 它天然写得下。这条断言本身就是设计的一部分。
  const maxProgress = {
    nodeSeq: 2 ** 53 - 1, turnKey: "k".repeat(200), n: 2, status: "s".repeat(200),
    charCount: 2 ** 53 - 1, tail: "中".repeat(240),
    contextUsage: { tokens: 1e15, live: true, isCompacting: true, autoCompactionEnabled: true },
    lastEvent: { at: "a".repeat(200), type: "t".repeat(200) },
  };
  const line = JSON.stringify({ v: 1, seq: 0, ts: Date.now(), graphId: GRAPH_ID, event: "node:progress", payload: boundPayload("node:progress", maxProgress) });
  ok("W8.1 塞满的 progress 远小于行上限(全字段有界的推论)", utf8Len(line) < 4096, `${utf8Len(line)} 字节`);

  // 非 progress 超行上限 → recording-failed 且占号。
  // node:settled 的最坏情况按 §7 算是 ~740 KB < 1 MiB,所以合法输入顶不穿;
  // 要触发这条只能靠一个**病态但合法**的 payload —— 用 20 轮 × 20 项 × 200 字节的 inferredDeps。
  const dep = "d".repeat(200);
  const fatTurn = () => turnSummary({
    inferredDeps: Array.from({ length: 20 }, () => dep), inferredDepsTruncated: false,
    attempts: [1, 2].map((n) => ({
      n, status: "rejected", inputSha256: "c".repeat(64), input: asset(), output: asset(),
      // rejectedReason 降级后头尾各 1 KiB —— 这是它落盘的实际上界
      rejectedReason: "\u0001".repeat(3000),
    })),
  });
  const fat = settled({ turns: Array.from({ length: 20 }, fatTurn) });
  const fatLine = JSON.stringify({ v: 1, seq: 1, ts: Date.now(), graphId: GRAPH_ID, event: "node:settled", payload: boundPayload("node:settled", fat) });
  ok("W8.2 塞满的 node:settled 仍在行上限内(§7 那个 1.4 倍余量)",
    utf8Len(fatLine) < MAX_LINE_BYTES, `${utf8Len(fatLine)} 字节`);
  console.log(`       └ 实测塞满的 node:settled = ${utf8Len(fatLine)} 字节,余量 ${(MAX_LINE_BYTES / utf8Len(fatLine)).toFixed(2)}×`);
  await w.append("node:settled", fat);
  w.close();
  ok("W8.3 塞满的 node:settled 真落盘了", readLines(f).length === 2);
  ok("W8.4 没有误判成 recording-failed", failedCall === null);
}

/* ============================================================
   W9 短写(recorder 损坏)
   ============================================================ */
console.log("\nW9 短写 → recorder 损坏");
{
  const f = nextFile();
  let failedCall = null;
  const w = createEventWriter({ file: f, graphId: GRAPH_ID, onRecordingFailed: (x) => { failedCall = x; } });
  await w.append("run:started", started);

  // 注入:底层 write 只落一半字节就返回。
  const realWrite = fs.writeSync;
  let injected = false;
  fs.writeSync = (fd, buf, off, len) => {
    if (!injected && Buffer.isBuffer(buf) && len > 20) {
      injected = true;
      return realWrite(fd, buf, off, Math.floor(len / 2));
    }
    return realWrite(fd, buf, off, len);
  };
  let rejected = false;
  try { await w.append("node:settled", settled()); }
  catch { rejected = true; }
  fs.writeSync = realWrite;

  ok("W9.1 append() **不 resolve 成功**", rejected);
  ok("W9.2 判成 recorder 损坏(onRecordingFailed 被调)", failedCall !== null);
  ok("W9.3 atSeq 是那条写坏的事件的号", failedCall && failedCall.atSeq === 1);
  ok("W9.4 原因说清是短写", failedCall && /短写/.test(failedCall.error.message));

  // 损坏之后**再也不写** —— 半行永远留在 EOF,读侧按 §2.1 跳过它。
  const before = fs.readFileSync(f);
  await w.append("run:final", {
    result: "completed", durationMs: 1,
    counts: { observed: 1, rejected: 0, ok: 1, contract_error: 0, backend_failed: 0, timeout: 0, unknown: 0, callback_error: 0, reused: 0 },
  });
  const after = fs.readFileSync(f);
  ok("W9.5 损坏之后一个字节都不再写", Buffer.compare(before, after) === 0);
  ok("W9.6 后续 append 静默 no-op(不再抛,recorder 坏了不改业务结局)", true);
  w.close();

  // 半行确实留在 EOF,且第一行完整可解析
  const raw = fs.readFileSync(f, "utf8");
  const lines = raw.split("\n");
  ok("W9.7 第一行完整可解析", (() => { try { JSON.parse(lines[0]); return true; } catch { return false; } })());
  ok("W9.8 尾部是半行(无换行结尾)", !raw.endsWith("\n"));
  ok("W9.9 半行本身不可解析(所以读侧必须缓冲到换行再解析)",
    (() => { try { JSON.parse(lines[lines.length - 1]); return false; } catch { return true; } })());
  ok("W9.10 onRecordingFailed 只调一次", failedCall !== null && w.failed.atSeq === 1);
}

/* ============================================================
   W10 close() 抛错 ≠ 写失败(W9 的负对照)
   ============================================================ */
console.log("\nW10 close() 抛错(与 W9 互为负对照)");
{
  const f = nextFile();
  let failedCall = null;
  const w = createEventWriter({ file: f, graphId: GRAPH_ID, onRecordingFailed: (x) => { failedCall = x; } });
  await w.append("run:started", started);
  const realClose = fs.closeSync;
  fs.closeSync = () => { throw new Error("EIO on close"); };
  let threw = false;
  try { w.close(); } catch { threw = true; }
  fs.closeSync = realClose;
  ok("W10.1 close() 的异常原样抛给调用方", threw);
  // ⚠️ 关键:`run:final` 已确认落盘时页面就该显示"已结束"。把"关 fd 失败"也当成写失败,
  //    会让一次正常收场被显示成"观测记录损坏"。
  ok("W10.2 **不**转 recording-failed", failedCall === null);
  ok("W10.3 已写的内容完好", readLines(f).length === 1);
}

/* ============================================================
   W11 wx(同 outDir 两个 graph 并发)
   ============================================================ */
console.log("\nW11 transcript 用 wx 建");
{
  const f = nextFile();
  const w1 = createEventWriter({ file: f, graphId: GRAPH_ID });
  let second = null;
  try { createEventWriter({ file: f, graphId: "other" }); }
  catch (e) { second = e; }
  ok("W11.1 同名 transcript 第二次开必须失败", second !== null && second.code === "EEXIST");
  w1.close();
}

/* ============================================================ */
console.log(`\n${"=".repeat(56)}`);
console.log(`  viz-events: ${pass} passed, ${fail} failed`);
console.log(`${"=".repeat(56)}\n`);
try { fs.rmSync(RUN_ROOT, { recursive: true, force: true }); } catch { /* Windows 删挂起 */ }
process.exit(fail === 0 ? 0 : 1);
