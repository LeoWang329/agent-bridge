// END-TO-END(真后端、真模型、真花钱):**真跑一次 → 观测台上看到的就是磁盘上的那份**。
//
//   node docs/repro-mcp-hang/e2e-graph-viz.mjs [--agent claude] [--model x] [--keep]
//
// 为什么这条必须用真后端(假后端已经有 repro-graph-viz 守着线格式与四道闸):
//
//   假后端跑出来的事件流,形状是**夹具决定**的。这条要考的恰恰是"形状由真实执行决定"
//   的那一段:真的模型、真的产出、真的字节数、真的耗时、真的现场。归档布局与事件里的
//   指纹**只有在真跑里才可能对不上** —— 夹具永远配合。
//
// 三段证据(缺一段就不算闭环):
//
//   ① 合同不变式    真 transcript 逐条过 `viz/contract-invariants.mjs`(跨字段的等式,
//                   schema 管不到那一类),含"归档文件与事件里的 sha256/byteCount 逐字节一致"。
//   ② 页面的读法    把**页面自己那个 reducer** 装进沙箱,喂这份真 transcript,
//                   断言它读出来的东西与**磁盘上的回执**一致(状态、轮数、产出路径)。
//                   ⚠️ 这是这条 e2e 的核心:合同两侧各自自洽不算数,要的是**同一份事实**。
//   ③ 真服务端      起 `viz/serve.mjs`,按页面的取法请求那份产出,断言拿到的字节
//                   与事件里的指纹对得上 —— 也就是页面上那句"这是记录里那一份"是真的。
//
// ⚠️ 跑完不删 outDir 只在 `--keep` 时;默认删掉,别在仓库里留下真实产出。

import { fork } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { withBridge } from "../../skills/agent-bridge-graph/tools/node-core.mjs";
import { checkInvariants } from "../../skills/agent-bridge-graph/viz/contract-invariants.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const VIZ = path.join(REPO, "skills", "agent-bridge-graph", "viz");

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const AGENT = flag("agent", "claude");
const MODEL = flag("model", null);
const KEEP = argv.includes("--keep");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`); }
};

/* ---------- 一个小工作区:内容自足,不依赖仓库里的任何东西 ---------- */
const work = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-graph-viz-"));
const outDir = path.join(work, ".graph");
fs.writeFileSync(path.join(work, "NOTE.md"),
  "# 便签\n\n这一行里藏着一个词:pomegranate。\n", "utf8");

/* ---------- 装页面的 reducer(只到 §8 之前 —— 那之后才碰 DOM) ---------- */
function loadReducer() {
  const src = fs.readFileSync(path.join(VIZ, "index.html"), "utf8").match(/<script>([\s\S]*?)<\/script>/)[1];
  const lines = src.split("\n");
  const cut = lines.findIndex((l) => l.includes("8. 状态与装配"));
  if (cut < 0) throw new Error("找不到 §8 边界 —— 页面结构变了,这条 e2e 要跟着改");
  const ctx = {
    console,
    document: { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
                createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }) },
    location: { protocol: "file:" },
  };
  vm.createContext(ctx);
  vm.runInContext(lines.slice(0, cut - 2).join("\n") +
    "\n;globalThis.__X = { newLiveState, applyEvent, buildScene };", ctx);
  return ctx.__X;
}

function httpGet(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => {
      const bufs = [];
      r.on("data", (d) => bufs.push(d));
      r.on("end", () => res({ status: r.statusCode, headers: r.headers, body: Buffer.concat(bufs) }));
    }).on("error", rej);
  });
}

/* ============================================================ */
console.log(`\n[e2e-graph-viz] 后端=${AGENT}${MODEL ? ` 模型=${MODEL}` : ""}  工作区=${work}`);

let receipts = null;
try {
  /* ---------- 真跑:两个节点,第二个必须读第一个的产出 ---------- */
  const base = { agent: AGENT, cwd: work, outDir, access: "read", timeoutMs: 600000,
                 ...(MODEL ? { model: MODEL } : {}) };
  receipts = await withBridge(async (b) => {
    const a = await b.runNode({ ...base, id: "read-note",
      prompt: "读 NOTE.md，把里面藏着的那个英文单词原样写出来，只写那个词，不要别的。" });
    /* ⚠️ 第二个节点**必须**提到第一个的产出文件名 —— 推断边就是这么被扫出来的。
          少了它，这条 e2e 就只验了两个互不相干的节点。 */
    const rel = path.relative(work, a.artifactPath).replace(/\\/g, "/");
    const c = await b.runNode({ ...base, id: "echo-back",
      prompt: `读 ${rel}，把里面那个词大写后原样输出，只输出那一个词。` });
    return { a, c };
  /* ⚠️ viz:true —— 事件记录**由它开启**;false 时连 transcript 都不写。
        顺带会起一个内置观测台,withBridge 退出时自己收干净。 */
  }, { viz: true, outDir });

  ok("R1 两个节点都跑成了", receipts.a.status === "ok" && receipts.c.status === "ok",
    `${receipts.a.status} / ${receipts.c.status}`);
  ok("R2 第一个节点确实读到了那个词",
    /pomegranate/i.test(fs.readFileSync(receipts.a.artifactPath, "utf8")),
    fs.readFileSync(receipts.a.artifactPath, "utf8").slice(0, 120));
  ok("R3 第二个节点确实读到了第一个的产出",
    /POMEGRANATE/.test(fs.readFileSync(receipts.c.artifactPath, "utf8")),
    fs.readFileSync(receipts.c.artifactPath, "utf8").slice(0, 120));

  /* ---------- ① 真 transcript 过合同不变式 ---------- */
  const runsRoot = path.join(outDir, "nodes", ".runs");
  const ids = fs.readdirSync(runsRoot);
  ok("I0 有且只有一份 transcript", ids.length === 1, ids.join(","));
  const graphId = ids[0];
  const lines = fs.readFileSync(path.join(runsRoot, graphId, "transcript.jsonl"), "utf8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  console.log(`\n[①] 合同不变式(真跑出来的 ${lines.length} 条)`);
  for (const r of checkInvariants(lines, { archiveRoot: outDir })) {
    if (r.weak) continue;
    ok(`I ${r.name}`, r.ok, r.detail);
  }

  /* ---------- ② 页面读出来的 == 磁盘上的回执 ---------- */
  console.log("\n[②] 页面 reducer 读出来的,与磁盘上的回执是同一份事实");
  const X = loadReducer();
  const R = X.newLiveState();
  for (const e of lines) X.applyEvent(R, e);
  R.replay.mode = "live";
  const sc = X.buildScene(R);
  const byId = Object.fromEntries(sc.nodes.map((n) => [n.id, n]));

  ok("P1 页面看到两个节点", sc.nodes.length === 2, String(sc.nodes.length));
  for (const [id, rec] of [["read-note", receipts.a], ["echo-back", receipts.c]]) {
    const n = byId[id];
    ok(`P2 ${id} 状态与回执一致`, n && n.status === rec.status, `${n && n.status} vs ${rec.status}`);
    ok(`P3 ${id} 有且只有一轮`, n && n.turns.length === 1, String(n && n.turns.length));
    ok(`P4 ${id} 那一轮恰好一次尝试`, n && n.turns[0].attempts.length === 1);
    /* ⚠️ 判据是"页面给的 ref 指着的那份字节 == 回执指的那份字节",**不是**两个路径字符串相等:
          归档区那份是 canonical 那份的副本,路径本来就不同。比字节才是比同一个事实。 */
    const ref = n && n.files && n.files.artifact.s === "have" ? n.files.artifact.ref : null;
    ok(`P5 ${id} 页面给得出产出入口`, !!ref, JSON.stringify(n && n.files && n.files.artifact));
    if (ref) {
      const onDisk = fs.readFileSync(path.join(outDir, ref));
      const canonical = fs.readFileSync(rec.artifactPath);
      ok(`P6 ${id} 页面指的那份产出与回执那份**逐字节相同**`,
        onDisk.equals(canonical), `${onDisk.length} vs ${canonical.length} 字节`);
    }
  }
  ok("P7 ★ 推断边真的被扫出来了(第二个节点提到了第一个的产出文件)",
    sc.edges.some((e) => e.kind === "inferred" &&
      e.a === (byId["read-note"] || {}).seq && e.b === (byId["echo-back"] || {}).seq),
    JSON.stringify(sc.edges.map((e) => [e.a, e.b, e.kind])));
  ok("P8 运行状态是「已结束」", sc.run.state === "ended" || sc.run.state === "ended_failed", sc.run.state);

  /* ---------- ③ 真服务端:按页面的取法拿那份产出,指纹对得上 ---------- */
  console.log("\n[③] 真 serve.mjs:页面那句「这是记录里那一份」是真的");
  /* ⚠️ `serve.mjs` **不往 stdout 打地址** —— 它是被 `fork()` 拉起的,端口走 IPC
        (`process.send({kind:"viz-listening", url})`)。用 `spawn` 等它打印会一直等到超时,
        而那个超时看起来像"服务端起不来",实际上它早就在监听了。 */
  const srv = fork(path.join(VIZ, "serve.mjs"), [], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    env: { ...process.env, VIZ_OUT_DIR: outDir, VIZ_GRAPH_ID: graphId, VIZ_PORT: "0" },
  });
  const url = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("serve.mjs 10 秒没报 viz-listening")), 10000);
    srv.on("message", (m) => { if (m && m.kind === "viz-listening") { clearTimeout(t); res(m.url); } });
    srv.on("error", rej);
    srv.on("exit", (c) => { clearTimeout(t); rej(new Error("serve.mjs 提前退出,码 " + c)); });
  });
  try {
    const st = lines.filter((l) => l.event === "node:settled").map((l) => l.payload);
    const art = st[st.length - 1].artifact;
    const r = await httpGet(`${url}file?ref=${encodeURIComponent(art.ref)}`);
    ok("S1 /file 拿得到那份产出", r.status === 200, String(r.status));
    ok("S2 ★ 响应体的 SHA-256 与事件里记的一致(页面就是这么对证的)",
      crypto.createHash("sha256").update(r.body).digest("hex") === art.sha256);
    ok("S3 ★ X-Graph-Sha256 也一致", r.headers["x-graph-sha256"] === art.sha256);
    ok("S4 事件里的 byteCount 与真实字节数一致", art.byteCount === r.body.length,
      `${art.byteCount} vs ${r.body.length}`);
    /* 两道闸是**分开**的,状态码也不同 —— 混成一句就分不出「这个 ref 本身非法」
       与「合法但不该给你」。前者 400(词法:绝对路径 / 含 `..`),后者 403(不在本次归档范围内)。 */
    const bad = await httpGet(`${url}file?ref=${encodeURIComponent("../../../etc/passwd")}`);
    ok("S5 含 .. 的 ref → 400(词法这一关就没过)", bad.status === 400, String(bad.status));
    const outside = await httpGet(`${url}file?ref=${encodeURIComponent("nodes/.runs/other-graph/x.md")}`);
    ok("S6 语法合法但不在本次归档范围内 → 403", outside.status === 403, String(outside.status));
  } finally {
    srv.kill();
  }
} catch (e) {
  fail++;
  console.log(`  [FAIL] 跑挂了 — ${e && e.stack || e}`);
} finally {
  if (KEEP) console.log(`\n  --keep:工作区保留在 ${work}`);
  else fs.rmSync(work, { recursive: true, force: true });
}

console.log(`\n${"=".repeat(56)}`);
console.log(`  e2e-graph-viz: ${pass} passed, ${fail} failed`);
console.log(`${"=".repeat(56)}\n`);
process.exit(fail ? 1 : 0);
