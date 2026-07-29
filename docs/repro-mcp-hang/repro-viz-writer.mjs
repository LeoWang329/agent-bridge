// `scripts/viz-writer.mjs` 的机器验收 —— 零消耗，不拉任何后端。
//
// 对应 PLAN §9 的 S1（writer 地基）与 S3a（纯 VizLedger 状态转移）。
// **每条断言都写死预期，不接受"产生预期结果"这种话。**
//
// 跑法:node docs/repro-mcp-hang/repro-viz-writer.mjs

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const WRITER = path.join(ROOT, "scripts/viz-writer.mjs");
const INVARIANTS = path.join(ROOT, "skills/agent-bridge/viz/contract-invariants.mjs");
const STATE_MD = path.join(ROOT, "skills/agent-bridge/viz/STATE.md");

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sect = t => console.log(`\n── ${t} ───────────────────────────────`);

const { createVizRun, vizCleanup, VIZ_DIR_PREFIX } = await import(`file://${WRITER}`);

// ── 测试用的 tmpdir 与 IO ───────────────────────────────────────────────────

/**
 * 把 tmpdir 指到一个专属目录。**这不是给 API 开目录参数**——是测试控制环境。
 *
 * ⚠️ **必须 async**。写成同步版再传 async 回调，`finally` 会在异步体还没跑完时就
 *    还原 env 并删掉目录——于是用例过不过**取决于操作系统当时有没有锁住文件**
 *    （有写在途 → 删不掉 → 侥幸通过；没有 → 删掉 → 读到 null）。
 *    这种假绿最难查，因为它换台机器、换个杀软状态就翻面。
 */
async function withTmp(fn) {
  const box = fs.mkdtempSync(path.join(os.tmpdir(), "vizwtest-"));
  const save = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  process.env.TEMP = process.env.TMP = process.env.TMPDIR = box;
  try { return await fn(box); }
  finally {
    for (const [k, v] of Object.entries(save)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try { fs.rmSync(box, { recursive: true, force: true }); } catch {}
  }
}

/** 记账 + 可注入故障的 IO。`maxInflight` 用来坐实"永不重叠写"。 */
function makeIo(opts = {}) {
  const real = {
    mkdirSync: p => fs.mkdirSync(p, { recursive: true }),
    mkdtempSync: p => fs.mkdtempSync(p),
    writeFileSync: (p, d) => fs.writeFileSync(p, d),
    rmSync: p => fs.rmSync(p, { recursive: true, force: true }),
  };
  const st = { inflight: 0, maxInflight: 0, writes: [], failNext: new Map() };
  return {
    st,
    ...real,
    async mkdir(p) { return fs.promises.mkdir(p, { recursive: true }); },
    async writeFile(p, d) {
      st.inflight++;
      if (st.inflight > st.maxInflight) st.maxInflight = st.inflight;
      try {
        await sleep(opts.delayMs ?? 1);
        const base = path.basename(p);
        const n = st.failNext.get(base) ?? 0;
        if (n > 0) { st.failNext.set(base, n - 1); throw new Error(`注入失败:${base}`); }
        st.writes.push(base);
        return fs.promises.writeFile(p, d);
      } finally { st.inflight--; }
    },
    async unlink(p) { return fs.promises.unlink(p).catch(() => {}); },
  };
}

function on(extra = {}) {
  return { AGENT_BRIDGE_VIZ: "on", ...extra };
}

/**
 * 等 writer **彻底静止**（不 sleep 定值，轮询到静止）。
 *
 * ⚠️ 判据必须是 `idle` 而不是 `pendingJobs === 0`：纯里程碑（如 `sessionOpened`）
 *    一个 job 都不产生，活儿全在快照合并槽里。只看队列就会在快照还没落盘时开读，
 *    做出一批**随机绿随机红**的用例。
 */
async function settleIo(rec, tries = 400) {
  for (let i = 0; i < tries; i++) {
    await sleep(5);
    if (rec._writer.idle) { await sleep(10); if (rec._writer.idle) return; }
  }
  throw new Error("writer 迟迟不静止");
}

const readSlot = (dir, i) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, `state.${i}.json`), "utf8")); } catch { return null; }
};
const latest = (dir) => {
  const a = readSlot(dir, 0), b = readSlot(dir, 1);
  if (!a) return b; if (!b) return a;
  return a.generation >= b.generation ? a : b;
};
const turnsOf = (snap, sid) => (snap.sessions.find(s => s.sessionId === sid)?.turns) || [];

// ═══════════════════════════════════════════════════════════════════════════
sect("S1-A 零副作用与开关");

{
  // ⚠️ **只比 `agent-bridge-viz-*` 这个 glob**，不做整个 tmpdir 深比较——
  //    机器上无关临时文件会让它假红，破坏自动化稳定性。
  const globOf = (d) => new Set(fs.readdirSync(d).filter(n => n.startsWith(VIZ_DIR_PREFIX)));
  await withTmp(async (box) => {
    const before = globOf(box);
    const r = spawnSync(process.execPath, ["--input-type=module", "-e",
      `await import(${JSON.stringify(`file://${WRITER}`)}); console.log("imported");`],
      { env: { ...process.env, AGENT_BRIDGE_VIZ: "on" }, encoding: "utf8" });
    ok("A1 import 本身零副作用（开关都开着也不建目录）",
      r.status === 0 && [...globOf(box)].length === before.size, r.stderr?.slice(0, 200));
  });

  await withTmp(async (box) => {
    const rec = createVizRun({ bridgeVersion: "test", env: {} });        // 开关未设
    ok("A2 `AGENT_BRIDGE_VIZ` 未设 → disabled + tmpdir 零产出（这是默认路径）",
      rec.enabled === false && rec.disabledReason === "off"
      && fs.readdirSync(box).filter(n => n.startsWith(VIZ_DIR_PREFIX)).length === 0);
    // disabled recorder 的每个方法都必须能安全地被调用
    let threw = null;
    try {
      rec.sessionOpened({ sessionId: "x" }); rec.attempt({ sessionId: "x" });
      rec.dispatch(null, { boundary: "rpc_ack" }); rec.sealAndStop(); rec.cleanup();
    } catch (e) { threw = e; }
    ok("A2 disabled recorder 全 no-op 且不抛", threw === null, String(threw));
  });

  await withTmp(async () => {
    const rec = createVizRun({ bridgeVersion: "test", env: on() });
    ok("A3 新 run 的 runId 与目录对得上", rec.enabled && rec.runId.startsWith("mcp-"));
    const meta = JSON.parse(fs.readFileSync(path.join(rec.dir, "meta.json"), "utf8"));
    ok("A3 meta.json 只有不可变身份字段（**不许有 degraded**）",
      !("degraded" in meta) && meta.runId === rec.runId && Number.isSafeInteger(meta.pid),
      JSON.stringify(meta));
    ok("A3 owner 文件在", fs.existsSync(path.join(rec.dir, "owner")));
    rec.cleanup();
  });

  // ⚠️ 这一条是**结构性**的：签名里没有目录参数 ⇒「writer 指向了别的目录」在公开面上到不了。
  //    所以不需要为那个状态写实现、原因码和验收（那会造出只有测试构造得出的绿灯）。
  ok("A4 `createVizRun()` 的签名里没有目录参数",
    !/createVizRun\(\{[^}]*\b(dir|path|root|tmpRoot|baseDir)\b/s.test(fs.readFileSync(WRITER, "utf8")),
    "签名里出现了目录参数");
}

// ═══════════════════════════════════════════════════════════════════════════
sect("S1-B 串行写与双槽");

{
  await withTmp(async () => {
    const io = makeIo({ delayMs: 6 });
    const rec = createVizRun({ bridgeVersion: "t", env: on(), io });
    rec.sessionOpened({ sessionId: "s1", agent: "codex", access: "read", cwd: "D:\\x" });
    // 一口气砸很多写进去，逼出并发
    for (let i = 0; i < 12; i++) {
      const a = rec.attempt({ sessionId: "s1", input: `输入 ${i}` });
      rec.dispatch(a, { boundary: "rpc_ack" });
      rec.settleOnce(a, { outcome: "completed", body: `正文 ${i}`, bodyKind: "final" });
    }
    await settleIo(rec);
    // **严格 === 1**：双槽协议的正确性建立在"永不重叠写"上。
    ok("B1 全生命周期最大并发写严格 === 1",
      io.st.maxInflight === 1 && rec._writer.maxInflightSeen === 1,
      `io=${io.st.maxInflight} writer=${rec._writer.maxInflightSeen}`);
    ok("B1 两个槽都被用过（写成功才切槽）",
      fs.existsSync(path.join(rec.dir, "state.0.json")) && fs.existsSync(path.join(rec.dir, "state.1.json")));
    rec.cleanup();
  });

  await withTmp(async () => {
    const rec = createVizRun({ bridgeVersion: "t", env: on() });
    rec.sessionOpened({ sessionId: "s1", agent: "omp" });
    await settleIo(rec);
    ok("B2 新 run 的 generation === 1", latest(rec.dir).generation === 1, JSON.stringify(latest(rec.dir)?.generation));
    rec.cleanup();
  });

  await withTmp(async () => {
    const io = makeIo();
    const rec = createVizRun({ bridgeVersion: "t", env: on(), io });
    rec.sessionOpened({ sessionId: "s1", agent: "omp" });
    await settleIo(rec);
    const g1 = latest(rec.dir).generation;
    // 下一次快照写注入失败 ×1
    io.st.failNext.set("state.1.json", 1);
    rec.sessionStatus("s1", { status: "running" });
    await sleep(60);
    ok("B3 快照写失败 → 保留上一代，**不把失败当已发布**", latest(rec.dir).generation === g1);
    await sleep(500);   // 自动重试
    ok("B3 dirty 保留并重试成功后才推进代次", latest(rec.dir).generation > g1,
      `now=${latest(rec.dir).generation} was=${g1}`);
    rec.cleanup();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
sect("S1-C 有界队列与降级");

{
  await withTmp(async () => {
    const io = makeIo({ delayMs: 3 });
    const rec = createVizRun({ bridgeVersion: "t", env: on(), io });
    rec.sessionOpened({ sessionId: "s1", agent: "omp" });
    // 塞爆 MAX_PENDING_JOBS(64)
    const ids = [];
    for (let i = 0; i < 90; i++) {
      const a = rec.attempt({ sessionId: "s1" });
      rec.dispatch(a, { boundary: "rpc_ack" });
      ids.push(a);
    }
    const proms = ids.map(a => rec.settleOnce(a, { outcome: "completed", body: "x".repeat(50), bodyKind: "final" }));
    // ⚠️ 队列拒绝时 `settleOnce()` 的共享 Promise **必须真的结束**——
    //    否则调用方跟着永久挂起，那才是真正致命的。
    const raced = await Promise.race([
      Promise.all(proms).then(() => "settled"),
      sleep(4000).then(() => "hung"),
    ]);
    ok("C1 队列被塞爆时 settleOnce 的 Promise 全部结束（不永久 pending）", raced === "settled");
    await settleIo(rec);
    const snap = latest(rec.dir);
    const full = turnsOf(snap, "s1").filter(t => t.output.error === "queue_full");
    ok("C1 有轮次因队列满而降级", full.length > 0, `queue_full 轮次=${full.length}`);
    if (full.length) {
      const t = full[0];
      // ⚠️ 字段名是 **output.error**，schema 里**没有** turn 级的 recordingError。
      //    断言写错字段名 = 断言了一个永远不存在的东西 = 假绿。
      ok("C1 降级四件套：settled + none + ref=null + output.error=queue_full",
        t.state === "settled" && t.bodyKind === "none" && t.output.ref === null && t.output.error === "queue_full",
        JSON.stringify({ s: t.state, b: t.bodyKind, r: t.output.ref, e: t.output.error }));
    }
    ok("C1 **三处同步**：run.degraded=true 且 recordingErrors 含 queue_full",
      snap.run.degraded === true && snap.run.recordingErrors.includes("queue_full"),
      JSON.stringify(snap.run));
    rec.cleanup();
  });

  await withTmp(async () => {
    const rec = createVizRun({ bridgeVersion: "t", env: on() });
    rec.sessionOpened({ sessionId: "s1", agent: "omp" });
    const a = rec.attempt({ sessionId: "s1" });
    rec.dispatch(a, { boundary: "rpc_ack" });
    // 单条超过 MAX_ITEM_BYTES(32 MiB)
    await rec.settleOnce(a, { outcome: "completed", body: "x".repeat(33 * 1024 * 1024), bodyKind: "final" });
    await settleIo(rec);
    const t = turnsOf(latest(rec.dir), "s1")[0];
    ok("C2 单条超上限 → settled + none + ref=null + output.error=queue_item_too_large",
      t.state === "settled" && t.bodyKind === "none" && t.output.ref === null
      && t.output.error === "queue_item_too_large",
      JSON.stringify({ s: t.state, b: t.bodyKind, r: t.output.ref, e: t.output.error }));
    rec.cleanup();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
sect("S1-D 悬空 ref 与提交顺序");

{
  await withTmp(async () => {
    const io = makeIo({ delayMs: 25 });
    const rec = createVizRun({ bridgeVersion: "t", env: on(), io });
    rec.sessionOpened({ sessionId: "s1", agent: "omp" });
    const a = rec.attempt({ sessionId: "s1", input: "很长的输入".repeat(50) });
    rec.dispatch(a, { boundary: "rpc_ack" });
    await sleep(4);
    const early = turnsOf(rec.snapshot(), "s1")[0];
    // ⚠️ dispatch 时输入文件**还没写完**，绝不能立刻公布可读 ref。
    ok("D1 dispatch 当下 input 是 pending 且 ref=null（不出现悬空引用）",
      early.input.state === "pending" && early.input.ref === null,
      JSON.stringify(early.input));
    ok("D1 dispatched 阶段 output 恒 pending 且计数恒 null",
      early.output.state === "pending" && early.output.chars === null && early.output.bytes === null,
      JSON.stringify(early.output));
    await settleIo(rec);
    const late = turnsOf(latest(rec.dir), "s1")[0];
    ok("D1 写成功之后才公布 ref + sha256",
      late.input.state === "ready" && /^[0-9a-f]{64}$/.test(late.input.sha256 || ""),
      JSON.stringify(late.input));
    ok("D1 ref 指向的文件真的存在且可读",
      fs.existsSync(path.join(rec.dir, late.input.ref)));
    rec.cleanup();
  });

  await withTmp(async () => {
    const io = makeIo();
    const rec = createVizRun({ bridgeVersion: "t", env: on(), io });
    rec.sessionOpened({ sessionId: "s1", agent: "omp" });
    const a = rec.attempt({ sessionId: "s1" });
    rec.dispatch(a, { boundary: "rpc_ack" });
    io.st.failNext.set("t1.out.md", 1);          // 正文写回调报错
    await rec.settleOnce(a, { outcome: "completed", body: "正文", bodyKind: "final" });
    await settleIo(rec);
    const t = turnsOf(latest(rec.dir), "s1")[0];
    // **completed + none 只在 output.error 非空时合法**——这里正是那种情况。
    ok("D2 正文写回调失败 → completed + none + output.error=write_failed（无悬空 ref）",
      t.outcome === "completed" && t.bodyKind === "none" && t.output.ref === null
      && t.output.error === "write_failed", JSON.stringify({ o: t.outcome, b: t.bodyKind, e: t.output.error }));
    ok("D2 连带置位 run.degraded", latest(rec.dir).run.degraded === true);
    rec.cleanup();
  });

  await withTmp(async () => {
    const io = makeIo();
    const rec = createVizRun({ bridgeVersion: "t", env: on(), io });
    rec.sessionOpened({ sessionId: "s1", agent: "omp" });
    const a = rec.attempt({ sessionId: "s1", input: "输入正文" });
    io.st.failNext.set("t1.in.md", 1);           // **input write callback 失败**
    rec.dispatch(a, { boundary: "rpc_ack" });
    await settleIo(rec);
    const t = turnsOf(latest(rec.dir), "s1")[0];
    ok("D3 输入写回调失败 → input.state=missing + ref=null + error（这条 v3 曾漏掉）",
      t.input.state === "missing" && t.input.ref === null && t.input.error === "write_failed",
      JSON.stringify(t.input));
    rec.cleanup();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
sect("S3a VizLedger 状态转移（零后端，纯单测）");

{
  await withTmp(async () => {
    const rec = createVizRun({ bridgeVersion: "t", env: on() });
    rec.sessionOpened({ sessionId: "s1", agent: "omp" });

    // ── 原子分配 turnNo ──
    const a = rec.attempt({ sessionId: "s1" });
    const ids = [rec.dispatch(a, { boundary: "rpc_ack" }), rec.dispatch(a, { boundary: "rpc_ack" }),
                 rec.dispatch(a, { boundary: "rpc_ack" })];
    ok("E1 acceptOrAdopt 原子：重复 dispatch 只分配一个 turnNo",
      new Set(ids).size === 1 && turnsOf(rec.snapshot(), "s1").length === 1,
      JSON.stringify(ids));

    // ── settleOnce 只发生一次转移且返回同一个 Promise ──
    const p1 = rec.settleOnce(a, { outcome: "completed", body: "A", bodyKind: "final" });
    const p2 = rec.settleOnce(a, { outcome: "failed", body: "B", bodyKind: "partial" });
    ok("E2 settleOnce 并发只发生一次转移，且返回同一个 Promise", p1 === p2);
    await p1; await settleIo(rec);
    const t = turnsOf(latest(rec.dir), "s1")[0];
    ok("E2 结算结果是第一次那个，不被第二次覆盖",
      t.outcome === "completed" && t.bodyKind === "final", JSON.stringify({ o: t.outcome, b: t.bodyKind }));
    rec.cleanup();
  });

  await withTmp(async () => {
    const rec = createVizRun({ bridgeVersion: "t", env: on() });
    rec.sessionOpened({ sessionId: "s1", agent: "omp" });
    // 7 种确定拒绝：全都**不产生 turnNo、不产生任何公开状态**。
    const REJECTS = ["空 message", "busy session", "OMP success:false", "Codex 明确 error",
                     "Claude stdin 写失败", "Cursor spawn 失败", "Kimi spawn 失败"];
    for (const why of REJECTS) { const x = rec.attempt({ sessionId: "s1" }); rec.reject(x, why); }
    await settleIo(rec);
    ok("E3 七种确定拒绝各自不产生 turnNo、不产生公开状态",
      turnsOf(rec.snapshot(), "s1").length === 0, JSON.stringify(turnsOf(rec.snapshot(), "s1")));

    // 3 种歧义：保留待认领，**不立即 settled**。
    const AMB = ["OMP ACK 超时", "OMP 写入后断链", "Codex turn/start 超时"];
    const ambIds = AMB.map(w => { const x = rec.attempt({ sessionId: "s1" }); rec.ambiguous(x, w); return x; });
    ok("E4 三种歧义都保留待认领，不产生公开轮次",
      turnsOf(rec.snapshot(), "s1").length === 0);

    // ⚠️ **多个 ambiguous 禁止认领**：仅凭 sessionId 无法知道终结属于哪个 prompt。
    const adopted = rec.adoptByTerminal("s1");
    ok("E5 多个歧义 + 终结事件 → 一个都不认领", adopted === null && turnsOf(rec.snapshot(), "s1").length === 0);
    ok("E5 转 unresolved 并置 degraded（不许永远挂在 ledger 上）",
      rec.snapshot().run.degraded === true && rec._ledger.session("s1").attempts.every(x => x.state !== "ambiguous"));
    void ambIds;
    rec.cleanup();
  });

  await withTmp(async () => {
    const rec = createVizRun({ bridgeVersion: "t", env: on() });
    rec.sessionOpened({ sessionId: "s2", agent: "omp" });
    const x = rec.attempt({ sessionId: "s2" });
    rec.ambiguous(x, "OMP ACK 超时");
    // ⚠️ **造一个真实的时间间隔**再认领。合同本身只要求 `>=`（严格 `>` 要求的是毫秒时钟
    //    分辨率，那不是实现能保证的东西，写死会变成随机红）。牙齿在这里：有了真实间隔，
    //    「把 dispatchedAt 抄成 attemptedAt」的实现照样过不去。
    await sleep(8);
    const got = rec.adoptByTerminal("s2");
    const got2 = rec.adoptByTerminal("s2");
    ok("E6 单个歧义 + 终结 → 恰好认领一次", got !== null && got2 === null);
    const t = turnsOf(rec.snapshot(), "s2")[0];
    // 没有任何 ACK 可依，证据只有后到的终结事件 → boundary 必须如实。
    ok("E6 认领后 boundary === terminal_adopted", t.boundary === "terminal_adopted", t.boundary);
    ok("E6 dispatchedAt 是**认领时刻**采样的，不是抄 attemptedAt",
      Date.parse(t.dispatchedAt) > Date.parse(t.attemptedAt),
      `${t.attemptedAt} → ${t.dispatchedAt}`);
    rec.cleanup();
  });

  await withTmp(async () => {
    const rec = createVizRun({ bridgeVersion: "t", env: on() });
    rec.sessionOpened({ sessionId: "s3", agent: "codex" });
    // 终结先于 ACK 到达 —— 不许造出没有 turnNo 的幽灵轮次，也不许"已结束却永远不 settle"。
    const x = rec.attempt({ sessionId: "s3" });
    rec.firstBackendEvent(x);
    await rec.settleOnce(x, { outcome: "completed", body: "早到的正文", bodyKind: "final" });
    ok("E7 ACK 之前的终结不产生公开轮次（暂存）", turnsOf(rec.snapshot(), "s3").length === 0);
    rec.dispatch(x, { boundary: "turn_start_ack" });
    await settleIo(rec);
    const t = turnsOf(latest(rec.dir), "s3")[0];
    ok("E7 ACK 到达后归并：轮次出现且已结算", !!t && t.state === "settled" && t.outcome === "completed",
      JSON.stringify(t && { s: t.state, o: t.outcome }));
    ok("E7 firstBackendEventAt 被保留（允许早于 dispatchedAt）", !!t?.firstBackendEventAt);
    rec.cleanup();
  });

  await withTmp(async () => {
    const rec = createVizRun({ bridgeVersion: "t", env: on() });
    rec.sessionOpened({ sessionId: "s4", agent: "claude" });
    const d = rec.attempt({ sessionId: "s4" }); rec.dispatch(d, { boundary: "pipe_enqueued" });
    const m = rec.attempt({ sessionId: "s4" }); rec.ambiguous(m, "超时");
    rec.sessionClosed("s4", { reason: "用户关闭" });
    await settleIo(rec);
    const ts = turnsOf(latest(rec.dir), "s4");
    // close finalizer 对三种内部态**各有确定结果**。
    ok("E8 close：dispatched → abandoned",
      ts.some(t => t.boundary === "pipe_enqueued" && t.outcome === "abandoned"), JSON.stringify(ts.map(t => t.outcome)));
    ok("E8 close：单个可认领 ambiguous → 先 adopt 再 abandoned",
      ts.some(t => t.boundary === "terminal_adopted" && t.outcome === "abandoned"), JSON.stringify(ts.map(t => t.boundary)));
    ok("E8 重复 close 幂等（不重复改、不新增轮次）", (() => {
      const g = latest(rec.dir).generation, n = ts.length;
      rec.sessionClosed("s4", { reason: "再关一次" });
      return latest(rec.dir).generation === g && turnsOf(rec.snapshot(), "s4").length === n;
    })());
    rec.cleanup();
  });

  await withTmp(async () => {
    const rec = createVizRun({ bridgeVersion: "t", env: on() });
    rec.sessionOpened({ sessionId: "s5", agent: "omp" });
    const a = rec.attempt({ sessionId: "s5" });
    rec.dispatch(a, { boundary: "rpc_ack", backendTurnId: "bt-999" });
    await rec.settleOnce(a, { outcome: "completed", body: "答案", bodyKind: "final" });
    await settleIo(rec);
    rec.collected("bt-999", { via: "wait", returnedChars: 6 });
    rec.collected("bt-999", { via: "result", returnedChars: 999 });
    await settleIo(rec);
    const t = turnsOf(latest(rec.dir), "s5")[0];
    ok("E9 backendTurnId → vizTurnId 映射正确并记下 collected", t.collected !== null);
    ok("E9 同一轮重复 collect **只记第一次**",
      t.collected?.via === "wait" && t.collected?.returnedChars === 6, JSON.stringify(t.collected));
    // 未取结果 = settled 且 collected 为 null —— 页面靠这个出「⚠️ 未取结果」。
    const b = rec.attempt({ sessionId: "s5" });
    rec.dispatch(b, { boundary: "rpc_ack" });
    await rec.settleOnce(b, { outcome: "completed", body: "没人来取", bodyKind: "final" });
    await settleIo(rec);
    ok("E9 没取的那轮 collected 保持 null", turnsOf(latest(rec.dir), "s5")[1].collected === null);
    rec.cleanup();
  });

  await withTmp(async () => {
    const rec = createVizRun({ bridgeVersion: "t", env: on() });
    rec.sessionOpened({ sessionId: "s6", agent: "cursor" });
    rec.sessionOpenFailed("s6", { phase: "start", error: "引擎没装" });
    rec.sessionClosed("s6", { reason: "清理" });
    await settleIo(rec);
    const s = latest(rec.dir).sessions.find(x => x.sessionId === "s6");
    // 顺序定死：**openFailed 优先，抑制该 sessionId 的 closed**。
    ok("F1 openFailed 抑制同 sessionId 的 closed",
      s.openFailed?.phase === "start" && s.closed === null, JSON.stringify({ of: s.openFailed, c: s.closed }));
    ok("F1 error 有 300 字硬顶", (() => {
      rec.sessionOpened({ sessionId: "s7", agent: "kimi" });
      rec.sessionOpenFailed("s7", { phase: "initialTurn", error: "长".repeat(999) });
      const t = rec.snapshot().sessions.find(x => x.sessionId === "s7");
      return t.openFailed.error.length === 300;
    })());
    rec.cleanup();
  });

  await withTmp(async () => {
    const rec = createVizRun({ bridgeVersion: "t", env: on() });
    rec.sessionOpened({ sessionId: "s8", agent: "omp" });
    const a = rec.attempt({ sessionId: "s8" });
    rec.dispatch(a, { boundary: "rpc_ack" });
    // 代理对：末 400 个 code unit 若从中间切开，页面上就是一个 U+FFFD。
    const emoji = "🌟".repeat(300);                       // 每个 2 个 code unit
    rec.progress(a, { charCount: emoji.length, tail: emoji, generationCount: 2 });
    await settleIo(rec);
    const sc = JSON.parse(fs.readFileSync(path.join(rec.dir, "turns/s8/t1.progress.json"), "utf8"));
    ok("F2 sidecar 尾巴不含落单代理（不出现 U+FFFD）",
      !/\uFFFD/.test(sc.tail) && sc.tail.length <= 400 && [...sc.tail].every(ch => ch === "🌟"),
      `len=${sc.tail.length}`);
    ok("F2 sidecar 身份字段齐全", sc.vizTurnId && sc.generationCount === 2);
    await rec.settleOnce(a, { outcome: "completed", body: "done", bodyKind: "final" });
    await settleIo(rec);
    await sleep(30);
    ok("F2 结算后 sidecar 被删除", !fs.existsSync(path.join(rec.dir, "turns/s8/t1.progress.json")));
    rec.cleanup();
  });

  await withTmp(async () => {
    const rec = createVizRun({ bridgeVersion: "t", env: on() });
    rec.sessionOpened({ sessionId: "s9", agent: "omp" });
    // 非有限值必须被挡在写入侧：NaN/Infinity 经 JSON.stringify 会静默变成 null，
    // 而 null 在这份 schema 里到处合法 —— 算错的数字会伪装成"这项没有"。
    rec.sessionStatus("s9", { backendPid: NaN });
    const s1 = rec.snapshot().sessions[0];
    rec.sessionStatus("s9", { backendPid: Infinity });
    const s2 = rec.snapshot().sessions[0];
    rec.sessionStatus("s9", { backendPid: -5 });
    const s3 = rec.snapshot().sessions[0];
    ok("F3 NaN / Infinity / 负数一律被挡成 null，不写进快照",
      s1.backendPid === null && s2.backendPid === null && s3.backendPid === null,
      JSON.stringify([s1.backendPid, s2.backendPid, s3.backendPid]));
    ok("F3 快照里没有任何非有限数",
      !/(NaN|Infinity)/.test(JSON.stringify(rec.snapshot())));
    rec.cleanup();
  });

  await withTmp(async () => {
    const rec = createVizRun({ bridgeVersion: "t", env: on() });
    rec.sessionOpened({ sessionId: "sa", agent: "cursor", contextUsage: null });
    rec.sessionOpened({ sessionId: "sb", agent: "omp",
      contextUsage: { tokens: 169601, live: true, isCompacting: true, autoCompactionEnabled: false } });
    const [a, b] = rec.snapshot().sessions;
    ok("F4 cursor 的 contextUsage 恒 null（未知，不是 0）", a.contextUsage === null);
    // ⚠️ isCompacting / autoCompactionEnabled **只有 OMP 会给**，必须透传、其余后端不出现。
    ok("F4 OMP 的两个额外字段被透传",
      b.contextUsage.isCompacting === true && b.contextUsage.autoCompactionEnabled === false,
      JSON.stringify(b.contextUsage));
    rec.cleanup();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
sect("S1-N 接线面：桥真的接得上吗（graph 侦察挖出来的四个缺口）");

{
  await withTmp(async () => {
    const rec = createVizRun({ bridgeVersion: "t", env: on() });
    rec.sessionOpened({ sessionId: "n1", agent: "omp" });
    const a = rec.attempt({ sessionId: "n1" });
    // ⚠️ `firstBackendEvent` / `progress` / OMP 的 `agent_end` / `abort` 所在的函数
    //    **没有 send() 的闭包**，而 pendingRpc 在 ACK 之后就删了。
    //    没有这个解析口，那几个点根本接不上线。
    ok("N1 sessionId → 当前 attempt 解析得到", rec.activeAttempt("n1") === a);
    rec.dispatch(a, { boundary: "rpc_ack" });
    await rec.settleOnce(a, { outcome: "completed", body: "x", bodyKind: "final" });
    await settleIo(rec);
    ok("N1 已结算的不再被解析出来（迟到事件不许打到上一轮头上）", rec.activeAttempt("n1") === null);
    rec.cleanup();
  });

  await withTmp(async () => {
    const rec = createVizRun({ bridgeVersion: "t", env: on() });
    rec.sessionOpened({ sessionId: "n2", agent: "omp" });
    const a = rec.attempt({ sessionId: "n2" });
    const b = rec.attempt({ sessionId: "n2" });
    rec.rpcRegister("n2", 11, a);
    rec.rpcRegister("n2", 12, b);
    ok("N2 rpcTake 取出并删除（重复取是安全的）",
      rec.rpcTake("n2", 11) === a && rec.rpcTake("n2", 11) === null);
    // 批量清理：进程崩 / #markUnresponsive / close 走这条。
    // 每个还挂着的一律转 ambiguous —— **超时或断链不等于后端没接受**。
    ok("N2 rpcDrainSession 清干净并把残留转 ambiguous",
      rec.rpcDrainSession("n2", "后端崩了") === 1
      && rec._ledger.pendingRpc.size === 0
      && rec._ledger.attempts.get(b).state === "ambiguous");
    rec.cleanup();
  });

  await withTmp(async () => {
    const rec = createVizRun({ bridgeVersion: "t", env: on() });
    rec.sessionOpened({ sessionId: "n3", agent: "omp" });
    const a = rec.attempt({ sessionId: "n3" });
    rec.dispatch(a, { boundary: "rpc_ack" });
    // ⚠️ 后端崩掉时事实是 `failed`，不是 `abandoned`。PLAN 原指望一个 poller 补这个差别，
    //    但退出期**没有下一拍**——补不上，abandoned 就会顶替 failed 写进记录。
    rec.markSessionTerminal("n3", { outcome: "failed", error: "OMP 进程意外退出 code=1" });
    await settleIo(rec);
    const t = turnsOf(latest(rec.dir), "n3")[0];
    ok("N3 后端终态收成 failed 而不是 abandoned",
      t.outcome === "failed" && /意外退出/.test(t.error || ""), JSON.stringify({ o: t.outcome, e: t.error }));
    rec.cleanup();
  });

  await withTmp(async () => {
    const rec = createVizRun({ bridgeVersion: "t", env: on() });
    rec.sessionOpened({ sessionId: "n4", agent: "omp" });
    // 两阶段正文：**同步转移状态，异步交正文**（OMP 的 250ms 宽限救尾巴）。
    const a = rec.attempt({ sessionId: "n4" });
    rec.dispatch(a, { boundary: "rpc_ack" });
    let late = "早到的一半";
    const p = rec.settleOnce(a, {
      outcome: "completed", bodyKind: "final",
      body: async () => { await sleep(120); return late; },
    });
    // 供体还没返回，但状态**已经**同步转过去了——护栏没松。
    ok("N4 供体在途时状态已同步转出 dispatched",
      rec._ledger.attempts.get(a).state === "settling");
    late = "早到的一半 + 迟到的尾巴";
    await p; await settleIo(rec);
    const t = turnsOf(latest(rec.dir), "n4")[0];
    const body = fs.readFileSync(path.join(rec.dir, t.output.ref), "utf8");
    ok("N4 落盘的是供体最终交出的那一份（尾巴救回来了）",
      body === "早到的一半 + 迟到的尾巴", body);
    rec.cleanup();
  });

  await withTmp(async () => {
    const rec = createVizRun({ bridgeVersion: "t", env: on() });
    rec.sessionOpened({ sessionId: "n5", agent: "omp" });
    const a = rec.attempt({ sessionId: "n5" });
    rec.dispatch(a, { boundary: "rpc_ack" });
    // 供体永不 resolve —— **绝不能让观测拖住桥**。
    const t0 = Date.now();
    await rec.settleOnce(a, { outcome: "completed", bodyKind: "final", body: () => new Promise(() => {}) });
    await settleIo(rec);
    const t = turnsOf(latest(rec.dir), "n5")[0];
    ok("N5 供体挂死时有硬顶（不超过 ~2.5s 就收口）", Date.now() - t0 < 2500, `${Date.now() - t0}ms`);
    // ⚠️ 供体挂了**绝不改动 outcome**：后端确实完成了，只是我们没记下来。
    ok("N5 outcome 保持 completed，降级只体现在 bodyKind/error 上",
      t.outcome === "completed" && t.bodyKind === "none" && t.output.error === "write_failed",
      JSON.stringify({ o: t.outcome, b: t.bodyKind, e: t.output.error }));
    ok("N5 且这是 §4.9 里 completed+none 唯一合法的形态（error 非空 + degraded）",
      latest(rec.dir).run.degraded === true);
    rec.cleanup();
  });

  {
    // 关掉观测是**默认路径**。桥会无条件调这些方法——少一个就是当场崩桥。
    const off = createVizRun({ bridgeVersion: "t", env: {} });
    let threw = null;
    try {
      off.activeAttempt("x"); off.rpcRegister("x", 1, "y"); off.rpcTake("x", 1);
      off.rpcDrainSession("x", "r"); off.markSessionTerminal("x", { outcome: "failed" });
    } catch (e) { threw = e; }
    ok("N6 disabled recorder 上这五个新方法全在且不抛", threw === null, String(threw));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
sect("S1-P 进度通道：高频不该把健康会话报成故障");

{
  await withTmp(async () => {
    const io = makeIo({ delayMs: 2 });
    const rec = createVizRun({ bridgeVersion: "t", env: on(), io });
    rec.sessionOpened({ sessionId: "sp", agent: "codex" });
    const a = rec.attempt({ sessionId: "sp" });
    rec.dispatch(a, { boundary: "turn_start_ack" });
    // 模拟**每 token 级**的 delta 回调：2000 次。
    // ⚠️ 这正是 codex 侦察挖出来的形态——progress 若进有界队列(64 条)，
    //    几百毫秒就打满 → queue_full → run.degraded → 页面对着一个**完全健康**的
    //    会话挂出「本次记录不完整」。**观测把被观测者报成了病人。**
    for (let i = 0; i < 2000; i++) {
      rec.progress(a, { charCount: i * 7, tail: `第 ${i} 段正在写的内容……`, generationCount: 1 + (i % 3) });
      if (i % 200 === 0) await sleep(1);
    }
    await settleIo(rec);
    const snap = latest(rec.dir);
    ok("P1 两千次高频进度不产生 queue_full",
      !snap.run.recordingErrors.includes("queue_full"), JSON.stringify(snap.run.recordingErrors));
    ok("P1 且**完全不置** degraded（健康会话就该报健康）",
      snap.run.degraded === false, JSON.stringify(snap.run));
    // 合并 + 最小间隔 ⇒ 实际落盘次数应远小于调用次数。
    const sidecarWrites = io.st.writes.filter(w => w === "t1.progress.json").length;
    ok("P1 落盘次数被合并到个位数量级（不是 2000 次）",
      sidecarWrites > 0 && sidecarWrites < 60, `实际写了 ${sidecarWrites} 次`);
    ok("P1 sidecar 内容是**最后一版**（最新即真，旧的可丢）", (() => {
      const sc = JSON.parse(fs.readFileSync(path.join(rec.dir, "turns/sp/t1.progress.json"), "utf8"));
      return sc.charCount === 1999 * 7;
    })());
    rec.cleanup();
  });

  await withTmp(async () => {
    const io = makeIo({ delayMs: 8 });
    const rec = createVizRun({ bridgeVersion: "t", env: on(), io });
    rec.sessionOpened({ sessionId: "sq", agent: "codex" });
    const a = rec.attempt({ sessionId: "sq" });
    rec.dispatch(a, { boundary: "turn_start_ack" });
    rec.progress(a, { charCount: 10, tail: "第一版", generationCount: 1 });
    await settleIo(rec);
    // 槽里再压一版**还没写出去**的，然后立刻结算。
    rec.progress(a, { charCount: 20, tail: "还没落盘的那一版", generationCount: 2 });
    await rec.settleOnce(a, { outcome: "completed", body: "答案", bodyKind: "final" });
    await settleIo(rec);
    await sleep(600);        // 跨过最小间隔，给"复活"留足机会
    // ⚠️ 顺序反了的话，槽里那一版会在删除**之后**把文件重新造出来 →
    //    一个已结算的轮次又长出 sidecar，viewer 会一直轮询一个永不更新的死文件。
    ok("P2 结算时丢弃槽内待写的进度，sidecar 不会在删除后复活",
      !fs.existsSync(path.join(rec.dir, "turns/sq/t1.progress.json")));
    rec.cleanup();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
sect("S1-G 退出期与孤儿回收");

{
  await withTmp(async () => {
    const io = makeIo({ delayMs: 30 });
    const rec = createVizRun({ bridgeVersion: "t", env: on(), io });
    rec.sessionOpened({ sessionId: "s1", agent: "omp" });
    const a = rec.attempt({ sessionId: "s1" });
    rec.dispatch(a, { boundary: "rpc_ack" });
    rec.settleOnce(a, { outcome: "completed", body: "正文", bodyKind: "final" });
    const before = io.st.writes.length;
    rec.sealAndStop();                     // ← run 退出
    await sleep(120);
    // **只做 O(1) 的封账 + 停止接收新任务，不写快照、不做任何 IO。**
    ok("G1 sealAndStop 之后不再有任何写（退出期零 snapshot I/O）",
      io.st.writes.length === before, `before=${before} after=${io.st.writes.length}`);
    ok("G1 封账后新的里程碑也不再落盘", (() => {
      rec.sessionOpened({ sessionId: "s2", agent: "codex" });
      return io.st.writes.length === before;
    })());
    rec.cleanup();
  });

  await withTmp(async (box) => {
    const rec = createVizRun({ bridgeVersion: "t", env: on() });
    const dir = rec.dir;
    rec.cleanup();
    ok("G2 cleanup 删掉整个目录", !fs.existsSync(dir));
    // 造一个"上一个进程 SIGKILL 留下的"目录：owner 里是一个不存在的 pid。
    const orphan = fs.mkdtempSync(path.join(box, VIZ_DIR_PREFIX));
    fs.writeFileSync(path.join(orphan, "owner"), JSON.stringify({ pid: 999999, startedAt: "x" }));
    const mine = fs.mkdtempSync(path.join(box, VIZ_DIR_PREFIX));
    fs.writeFileSync(path.join(mine, "owner"), JSON.stringify({ pid: process.pid, startedAt: "x" }));
    const r = vizCleanup({ tmpRoot: box, isAlive: (pid) => pid === process.pid });
    ok("G3 孤儿被回收", r.removed.includes(orphan) && !fs.existsSync(orphan));
    // ⚠️ 光看 pid 会误杀——操作系统会把号码回收再分给别的进程。自己的必须留着。
    ok("G3 owner 还活着的**绝不**删", r.kept.includes(mine) && fs.existsSync(mine));
  });
}

// ═══════════════════════════════════════════════════════════════════════════
sect("S1-H 独立第二实现（STATE.md §11）");

{
  const src = fs.readFileSync(INVARIANTS, "utf8");
  const imports = [...src.matchAll(/^\s*import\s+[\s\S]*?from\s+["']([^"']+)["']/gm)].map(m => m[1]);
  // ⚠️ **源码级检查，不是口头约定**：同一份代码验自己造的数据，只能证明"我和我自己一致"。
  ok("H1 contract-invariants.mjs 只 import Node 内建，没碰生产侧任何模块",
    imports.length > 0 && imports.every(x => x.startsWith("node:")), JSON.stringify(imports));
  ok("H1 它也没有从主文件或 writer 取任何常量",
    !/viz-writer|agent-bridge\.mjs|from\s+["']\.\.?\//.test(src));
  ok("H2 STATE.md 在，且是 wire 真理源", fs.existsSync(STATE_MD)
    && /唯一 *wire *真理源|唯一真理源/.test(fs.readFileSync(STATE_MD, "utf8")));
}

// ═══════════════════════════════════════════════════════════════════════════
sect("S1-R 复审第 1 轮的收口（每条都写死预期，不接受「产生预期结果」）");

{
  // ── H1：重试预算只用来**降频**，绝不用来放弃 ──
  //
  // 危险恰恰在磁盘恢复之后：最新那一代里带着 `degraded`，把它丢掉就等于
  // **在记录已经不完整的时候，页面显示一切正常**。
  await withTmp(async () => {
    const io = makeIo();
    const rec = createVizRun({ bridgeVersion: "t", env: on(), io });
    rec.sessionOpened({ sessionId: "s1", agent: "codex" });
    await settleIo(rec);
    const g0 = latest(rec.dir).generation;

    // 让接下来两个槽各连续失败 4 次——**刚好越过** SNAPSHOT_RETRY_MAX(3)，
    // 于是第 5 次落在慢速档(5s)上。次数不能随手写大：每多失败一次就多等 5 秒，
    // 而"等得不够久"会伪装成"实现放弃了重试"——正是这条用例要区分的两件事。
    io.st.failNext.set("state.0.json", 4);
    io.st.failNext.set("state.1.json", 4);
    const a = rec.attempt({ sessionId: "s1", input: "x" });
    rec.dispatch(a, { boundary: "turn_start_ack" });
    await sleep(1200);
    ok("R-H1 快速重试烧完后仍停在旧代（没把失败当已发布）", latest(rec.dir).generation === g0);
    // 此刻磁盘“恢复”：failNext 已耗尽。慢速重试必须把最新一代补上去。
    await sleep(6000);
    const now = latest(rec.dir);
    ok("R-H1 ★ 超预算后改慢速重试而非放弃，磁盘恢复即补发最新一代",
      now.generation > g0 && turnsOf(now, "s1").length === 1,
      `g0=${g0} now=${now.generation} turns=${turnsOf(now, "s1").length}`);
    rec.cleanup();
  });

  // ── H2 / §4.7：`truncated === false ⟹ bytes === originalBytes`（含同为 null） ──
  await withTmp(async () => {
    const rec = createVizRun({ bridgeVersion: "t", env: on() });
    rec.sessionOpened({ sessionId: "s1", agent: "codex" });
    const a = rec.attempt({ sessionId: "s1", input: "问题原文" });
    rec.dispatch(a, { boundary: "rpc_ack" });
    await settleIo(rec);
    const t = turnsOf(latest(rec.dir), "s1")[0];
    ok("R-H2 未截断输入的 originalBytes 恒等于 bytes（不再留 null）",
      t.input.truncated === false && t.input.bytes > 0 && t.input.originalBytes === t.input.bytes,
      JSON.stringify(t.input));

    const b = rec.attempt({ sessionId: "s1", input: { text: "保存下来的一段", truncated: true, originalBytes: 999999 } });
    rec.dispatch(b, { boundary: "rpc_ack" });
    await settleIo(rec);
    const t2 = turnsOf(latest(rec.dir), "s1")[1];
    ok("R-H2 截断输入如实记原始尺寸（页面据此说「原始 X / 保存 Y」）",
      t2.input.truncated === true && t2.input.originalBytes === 999999 && t2.input.bytes < 999999,
      JSON.stringify(t2.input));
    rec.cleanup();
  });

  // ── H3：`outcome × bodyKind` 归一，矩阵外组合一个都别想上 wire ──
  await withTmp(async () => {
    const rec = createVizRun({ bridgeVersion: "t", env: on() });
    rec.sessionOpened({ sessionId: "s1", agent: "codex" });

    const a = rec.attempt({ sessionId: "s1", input: "x" });
    rec.dispatch(a, { boundary: "rpc_ack" });
    // 调用方**明说** final —— 桥那边写出这种组合毫无阻力，而 §4.9 里 failed×final 是 ❌。
    rec.settleOnce(a, { outcome: "failed", body: "写到一半的东西", bodyKind: "final" });
    await settleIo(rec);
    const t = turnsOf(latest(rec.dir), "s1")[0];
    ok("R-H3 ★ failed + final 被归一成 failed + partial（矩阵外组合进不了 wire）",
      t.outcome === "failed" && t.bodyKind === "partial" && t.output.state === "ready",
      JSON.stringify({ outcome: t.outcome, bodyKind: t.bodyKind, out: t.output.state }));

    const b = rec.attempt({ sessionId: "s1", input: "y" });
    rec.dispatch(b, { boundary: "rpc_ack" });
    rec.settleOnce(b, { outcome: "谁知道是什么", body: "正文", bodyKind: "彻底乱写" });
    await settleIo(rec);
    const t2 = turnsOf(latest(rec.dir), "s1")[1];
    ok("R-H3 枚举外的值被收进封闭枚举，不原样穿透",
      ["completed", "failed", "aborted", "abandoned"].includes(t2.outcome)
      && ["final", "partial", "none"].includes(t2.bodyKind),
      JSON.stringify({ outcome: t2.outcome, bodyKind: t2.bodyKind }));

    const c = rec.attempt({ sessionId: "s1", input: "z" });
    rec.dispatch(c, { boundary: "rpc_ack" });
    rec.settleOnce(c, { outcome: "completed", body: "最终答复", bodyKind: "final" });
    await settleIo(rec);
    const t3 = turnsOf(latest(rec.dir), "s1")[2];
    ok("R-H3 归一化**没有**把合法的 completed + final 也一起降级",
      t3.outcome === "completed" && t3.bodyKind === "final");
    rec.cleanup();
  });

  // ── H4：超过传输上限的正文必须带前缀指纹 ──
  //
  // 队列单项上限(32 MiB)比传输上限(8 MiB)宽，中间这一段会被判成完好的 ready，
  // 而 `/file` 只发得出前 8 MiB。页面手上只有全文指纹 → 拿前缀对全文 → **当场误报篡改**。
  await withTmp(async () => {
    const { VIZ_FILE_MAX_BYTES, utf8BoundaryPrefix } =
      await import(`file://${path.join(ROOT, "scripts/viz-http.mjs")}`);
    const crypto = await import("node:crypto");
    const rec = createVizRun({ bridgeVersion: "t", env: on() });
    rec.sessionOpened({ sessionId: "s1", agent: "codex" });

    const small = rec.attempt({ sessionId: "s1", input: "x" });
    rec.dispatch(small, { boundary: "rpc_ack" });
    rec.settleOnce(small, { outcome: "completed", body: "短正文", bodyKind: "final" });
    await settleIo(rec);
    ok("R-H4 未超限的正文**不**写预览字段（免得页面以为自己拿到的是前缀）",
      turnsOf(latest(rec.dir), "s1")[0].output.previewSha256 === null);

    // 刚好越过上限一点点。用多字节字符收尾，顺带考 UTF-8 边界。
    const body = "字".repeat(Math.ceil(VIZ_FILE_MAX_BYTES / 3) + 64);
    const big = rec.attempt({ sessionId: "s1", input: "y" });
    rec.dispatch(big, { boundary: "rpc_ack" });
    rec.settleOnce(big, { outcome: "completed", body, bodyKind: "final" });
    await settleIo(rec);
    const t = turnsOf(latest(rec.dir), "s1")[1];
    const buf = Buffer.from(body, "utf8");
    const prefix = utf8BoundaryPrefix(buf, VIZ_FILE_MAX_BYTES);
    const expect = crypto.createHash("sha256").update(prefix).digest("hex");
    ok("R-H4 ★ 超限正文写出 previewBytes/previewSha256，且与传输层同一算法逐字节对上",
      t.output.previewBytes === prefix.length && t.output.previewSha256 === expect,
      JSON.stringify({ got: t.output.previewBytes, want: prefix.length, sha: t.output.previewSha256 === expect }));
    ok("R-H4 预览截在 UTF-8 完整边界上（不多不少，且不等于全文长度）",
      prefix.length <= VIZ_FILE_MAX_BYTES && prefix.length < buf.length);
    rec.cleanup();
  });

  // ── M13：sessionId 直接当目录名，`.` 和 `-` 在 SAFE_ID 白名单里，于是 `..` 能整个混过去 ──
  //
  // ⚠️ 判据是「这一段等不等于 `.` / `..`」，**不是「含不含 `..` 这两个字符」**。
  //    复审给的修法是 `id.includes("..")`，那会连 `a..b` 一起拒掉——而 `a..b` 是个
  //    普普通通的文件名，`path.join` 不会拿它去上跳一层。SAFE_ID 本来就排除了 `/` 和 `\`，
  //    所以能造成穿越的取值**有且只有** `.` 与 `..` 这两个整段。
  //    多拒的那部分不是"更安全"，是**把合法输入判成攻击**：真撞上就变成一个会话凭空消失，
  //    而页面上没有任何东西解释它去哪了。
  await withTmp(async () => {
    const rec = createVizRun({ bridgeVersion: "t", env: on() });
    for (const id of ["..", ".", "a/b", "a\\b", "a..b", "good-1"]) {
      rec.sessionOpened({ sessionId: id, agent: "codex" });
    }
    await settleIo(rec);
    const ids = latest(rec.dir).sessions.map(s => s.sessionId);
    ok("R-M13 ★ `..` / `.` 整段被拒（否则输入文件写到 VIZ_DIR 根部、ref 永久 400）",
      !ids.includes("..") && !ids.includes("."), JSON.stringify(ids));
    ok("R-M13 带路径分隔符的 id 也拒（SAFE_ID 已挡，这里坐实它没被绕开）",
      !ids.includes("a/b") && !ids.includes("a\\b"), JSON.stringify(ids));
    ok("R-M13 而 `a..b` 这种普通名字**必须放行**——收紧不等于宁可错杀",
      ids.includes("a..b") && ids.includes("good-1"), JSON.stringify(ids));

    // 被拒的会话不该在磁盘上留下任何痕迹。
    // ⚠️ 不能用 `path.join(dir,"turns","..")` 去 existsSync —— join 会把 `..` 折叠掉，
    //    那句话实际问的是「dir 在不在」，恒为真，是一条永远不会红的假断言。
    const turnsDir = path.join(rec.dir, "turns");
    const entries = fs.existsSync(turnsDir) ? fs.readdirSync(turnsDir) : [];
    ok("R-M13 被拒的会话不产生目录", !entries.includes("..") && !entries.includes("."),
      JSON.stringify(entries));
    rec.cleanup();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
sect("S1-K 正文宽限期里到达的收口不许丢");

// 真实时序就是这样的:结算时正文还在宽限期里(OMP 要等最后一条 message_update),
// 而调用方的 `wait` 早就返回、正文早就交到它手上了。
// 按"非 settled 一律丢弃"的老写法,这一条会被静默丢掉 ——
// 于是**一次已经取走的交付被记成「从未被取走」**,页面挂出"未取结果"的假警报。
// 这是桥插桩的回归(repro-viz-bridge)先抓到的;判据挪到这里,因为它是 writer 的合同。
{
  await withTmp(async () => {
    const rec = createVizRun({ bridgeVersion: "t", env: on() });
    rec.sessionOpened({ sessionId: "s1", agent: "omp" });
    const a = rec.attempt({ sessionId: "s1", input: "x" });
    rec.dispatch(a, { boundary: "rpc_ack" });
    rec.bindBackendTurnId(a, "turn-1");

    // 正文供体故意慢 —— 结算期间 attempt 停在 `settling`
    let release;
    const slow = new Promise(r => { release = r; });
    rec.settleOnce(a, { outcome: "completed", bodyKind: "final", body: () => slow });

    // 就在这一刻收口到达(调用方拿到结果了)
    rec.collected("turn-1", { via: "wait", returnedChars: 6, truncated: false });

    release("最终答复");
    await settleIo(rec);

    const t = turnsOf(latest(rec.dir), "s1")[0];
    ok("R-K1 ★ settling 期间到达的 collected 不丢,结算完成时兑现",
      t.state === "settled" && t.collected?.via === "wait" && t.collected.returnedChars === 6,
      JSON.stringify({ state: t.state, collected: t.collected }));
    ok("R-K1 兑现之后仍满足合同蕴含式 3(collected ⟹ settled)", t.collected !== null && t.state === "settled");

    // 幂等仍在:第二次收口不覆盖第一次
    rec.collected("turn-1", { via: "result", returnedChars: 999 });
    await settleIo(rec);
    const t2 = turnsOf(latest(rec.dir), "s1")[0];
    ok("R-K1 同一轮重复收口只记第一次", t2.collected.via === "wait" && t2.collected.returnedChars === 6,
      JSON.stringify(t2.collected));
    rec.cleanup();
  });

  // 反向:还没 dispatch 就来的收口**不该**被暂存(那时连轮次都还没公开)
  await withTmp(async () => {
    const rec = createVizRun({ bridgeVersion: "t", env: on() });
    rec.sessionOpened({ sessionId: "s1", agent: "omp" });
    const a = rec.attempt({ sessionId: "s1", input: "x" });
    rec.bindBackendTurnId(a, "turn-9");
    rec.collected("turn-9", { via: "result", returnedChars: 1 });
    rec.dispatch(a, { boundary: "rpc_ack" });
    rec.settleOnce(a, { outcome: "completed", body: "正文", bodyKind: "final" });
    await settleIo(rec);
    const t = turnsOf(latest(rec.dir), "s1")[0];
    ok("R-K2 未结算(仍 dispatched)时到达的收口不被暂存——它描述的是取走产出,而那时没有产出",
      t.collected === null, JSON.stringify(t.collected));
    rec.cleanup();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
sect("S1-X 交叉核对：writer 的真实产出必须过独立校验器");

// ⚠️ **这一条是这套双实现真正的收口，别的都只是它的特例。**
//
// 在它之前，两侧各有一批很漂亮的绿灯，却谁都没做过这件最朴素的事：
// **把 writer 真跑出来的目录，交给独立校验器判一次。**
// 校验器一直在验人手写的冻结样例，writer 一直在被自家 repro 验字段 ——
// 中间那条缝里当场躺着一个真漂移（`logFile`：writer 发 null，校验器要字符串），
// 两侧 190 多条断言一条都没红。
//
// 所以判据必须是**整目录、全形态**：settled + 仍在跑的 dispatched + 启动就失败的会话。
// 只喂一种形态，下一次漂移照样从没被喂过的那种里钻出来。
{
  const { checkVizDir } = await import(`file://${INVARIANTS}`);

  await withTmp(async () => {
    const rec = createVizRun({ bridgeVersion: "t", env: on() });

    rec.sessionOpened({ sessionId: "s-done", agent: "codex", access: "read", cwd: "D:\\repo" });
    const a = rec.attempt({ sessionId: "s-done", input: "问题原文" });
    rec.dispatch(a, { boundary: "rpc_ack" });
    rec.settleOnce(a, { outcome: "completed", body: "答复正文", bodyKind: "final" });
    rec.collected(rec._ledger.attempts.get(a)?.backendTurnId ?? "n/a", { via: "wait", returnedChars: 4 });

    rec.sessionOpened({ sessionId: "s-live", agent: "omp", access: "write", cwd: "D:\\repo" });
    const b = rec.attempt({ sessionId: "s-live", input: "还在跑的一轮" });
    rec.dispatch(b, { boundary: "rpc_ack" });          // 故意不结算：留一个公开的 dispatched
    rec.progress(b, { tail: "写到一半…", charCount: 6, generationCount: 1 });

    rec.sessionOpened({ sessionId: "s-dead", agent: "kimi", access: "read", cwd: "D:\\repo" });
    rec.sessionOpenFailed("s-dead", { phase: "start", error: "起不来" });

    await settleIo(rec);

    const v = checkVizDir(rec.dir);
    ok("X1 ★ writer 真实产出通过独立校验器（settled + dispatched + openFailed 三种形态同在）",
      v.violations.length === 0 && v.chosen !== null,
      JSON.stringify({ chosen: v.chosen, violations: v.violations }));

    // 顺带坐实：选出来的确实是最新一代，而不是"碰巧有一个槽能过"。
    // ⚠️ 判据要读**被选中那个槽自己的 generation**，别去猜槽位怎么轮换 ——
    //    猜错了就只好补一句 `|| chosen !== null` 兜底，而那句会把整条断言变成永远绿。
    const snap = latest(rec.dir);
    const chosenGen = v.chosen
      ? JSON.parse(fs.readFileSync(path.join(rec.dir, v.chosen), "utf8")).generation : null;
    ok("X1 校验器选中的槽就是最新一代", chosenGen === snap.generation,
      JSON.stringify({ chosen: v.chosen, chosenGen, latest: snap.generation }));
    ok("X1 三个会话都在快照里（启动失败的也要占一张卡片）",
      snap.sessions.length === 3, JSON.stringify(snap.sessions.map(s => s.sessionId)));
    rec.cleanup();
  });

  // 降级路径也要过：`degraded` / `recordingErrors` 与 output.error 的三处连带同步，
  // 恰恰是最容易只在一侧实现的部分。
  await withTmp(async () => {
    const io = makeIo();
    const rec = createVizRun({ bridgeVersion: "t", env: on(), io });
    rec.sessionOpened({ sessionId: "s1", agent: "claude", access: "read", cwd: "D:\\repo" });
    const a = rec.attempt({ sessionId: "s1", input: "x" });
    rec.dispatch(a, { boundary: "pipe_enqueued" });
    io.st.failNext.set("t1.out.md", 1);                 // 正文写失败 → 必须点亮 degraded
    rec.settleOnce(a, { outcome: "completed", body: "本该留下的正文", bodyKind: "final" });
    await settleIo(rec);

    const snap = latest(rec.dir);
    const t = turnsOf(snap, "s1")[0];
    ok("X2 正文写失败被如实记成 completed + none + output.error",
      t.outcome === "completed" && t.bodyKind === "none" && t.output.error === "write_failed",
      JSON.stringify({ o: t.outcome, k: t.bodyKind, e: t.output.error }));
    const v = checkVizDir(rec.dir);
    ok("X2 ★ 降级快照同样通过独立校验器（三处连带同步没漏）",
      v.violations.length === 0, JSON.stringify(v.violations));
    rec.cleanup();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
sect("S1-T 复审第 2 轮的收口：晚交的正文，标签也得晚判");

const { checkVizDir: checkDirT } = await import(`file://${INVARIANTS}`);

// 这一节钉住两条在复审第 2 轮才浮出来的合同,它们有一个共同的根:
// **观测侧手上的正文,未必是后端产出的全部** —— 而"标错"比"记少"严重得多。
{
  // ── T1:`bodyKind` 允许是函数,入参就是最终到手的正文 ──────────────────────
  // 为什么必须允许:OMP 的正文晚 250ms 才交(等最后一条 message_update)。
  // 结算那一瞬间把 kind 定死,宽限期里流进来的字就再也影响不了它 ——
  // 于是一份"其实还在长、最后被截断了"的正文,顶着结算瞬间算出的 `final` 落盘。
  await withTmp(async () => {
    const rec = createVizRun({ bridgeVersion: "t", env: on() });
    rec.sessionOpened({ sessionId: "s1", agent: "omp" });
    const a = rec.attempt({ sessionId: "s1", input: "x" });
    rec.dispatch(a, { boundary: "rpc_ack" });

    let release;
    const slow = new Promise(r => { release = r; });
    let sawBody = null;
    rec.settleOnce(a, {
      outcome: "completed",
      body: () => slow,
      bodyKind: (text) => { sawBody = text; return text.length >= 8 ? "partial" : "final"; },
    });
    release("这份正文已经超过阈值了");     // 长度 > 12 ⇒ 判据必须看见完整的它
    await settleIo(rec);

    const t = turnsOf(latest(rec.dir), "s1")[0];
    ok("R-T1 ★ bodyKind 函数拿到的是**最终到手的正文**,不是结算瞬间的空值",
      sawBody === "这份正文已经超过阈值了", JSON.stringify(sawBody));
    ok("R-T1 ★ 晚判出来的 partial 真的落进了快照(没有被结算瞬间的值顶掉)",
      t.bodyKind === "partial" && t.outcome === "completed",
      JSON.stringify({ o: t.outcome, k: t.bodyKind }));
    rec.cleanup();
  });

  // 短正文走同一条路 ⇒ final。**没有这一条,上面那条可以靠"永远返回 partial"作弊通过。**
  await withTmp(async () => {
    const rec = createVizRun({ bridgeVersion: "t", env: on() });
    rec.sessionOpened({ sessionId: "s1", agent: "omp" });
    const a = rec.attempt({ sessionId: "s1", input: "x" });
    rec.dispatch(a, { boundary: "rpc_ack" });
    rec.settleOnce(a, {
      outcome: "completed",
      body: () => Promise.resolve("短"),
      bodyKind: (text) => (text.length >= 8 ? "partial" : "final"),
    });
    await settleIo(rec);
    const t = turnsOf(latest(rec.dir), "s1")[0];
    ok("R-T2 同一个判据在短正文上给出 final(证明上一条不是恒 partial 蒙对的)",
      t.bodyKind === "final", JSON.stringify({ k: t.bodyKind }));
    rec.cleanup();
  });

  // ── T3:判据函数抛错,按「没标」处理,**绝不因此改动 outcome** ─────────────
  await withTmp(async () => {
    const rec = createVizRun({ bridgeVersion: "t", env: on() });
    rec.sessionOpened({ sessionId: "s1", agent: "omp" });
    const a = rec.attempt({ sessionId: "s1", input: "x" });
    rec.dispatch(a, { boundary: "rpc_ack" });
    rec.settleOnce(a, {
      outcome: "completed",
      body: () => Promise.resolve("正文还在"),
      bodyKind: () => { throw new Error("boom"); },
    });
    await settleIo(rec);
    const t = turnsOf(latest(rec.dir), "s1")[0];
    ok("R-T3 ★ 判据抛错不牵连 outcome(后端确实完成了,只是我们没标好)",
      t.outcome === "completed", JSON.stringify({ o: t.outcome }));
    ok("R-T3 抛错时退回默认判据(有正文 ⇒ final),正文本身不丢",
      t.bodyKind === "final" && t.output.state === "ready",
      JSON.stringify({ k: t.bodyKind, s: t.output.state }));
    rec.cleanup();
  });

  // ── T4:后端崩了,已经流出来的那截必须留下,而且**只留给正在跑的那一轮** ────
  // 为什么"只留给一轮"是硬要求:`markSessionTerminal` 会遍历所有 dispatched 轮次。
  // 一视同仁地把同一段正文写给每一轮,就是**把一轮的产出复制到另一轮头上** ——
  // 丢掉只是缺数据,复制是假数据,后者更难发现也更致命。
  await withTmp(async () => {
    const rec = createVizRun({ bridgeVersion: "t", env: on() });
    rec.sessionOpened({ sessionId: "s1", agent: "omp", access: "read", cwd: "D:\repo" });
    const a1 = rec.attempt({ sessionId: "s1", input: "第一问" });
    rec.dispatch(a1, { boundary: "rpc_ack" });
    const a2 = rec.attempt({ sessionId: "s1", input: "第二问" });   // a2 成为 activeAttempt
    rec.dispatch(a2, { boundary: "rpc_ack" });

    rec.markSessionTerminal("s1", {
      outcome: "failed", error: "backend died",
      body: "崩之前它说到这儿", bodyKind: "partial",
    });
    await settleIo(rec);

    const ts = turnsOf(latest(rec.dir), "s1");
    const t1 = ts.find(t => t.turnNo === 1), t2 = ts.find(t => t.turnNo === 2);
    ok("R-T4 ★ 崩溃前流出来的那截留在了**正在跑的那一轮**上",
      t2.bodyKind === "partial" && t2.output.state === "ready" && t2.outcome === "failed",
      JSON.stringify({ o: t2.outcome, k: t2.bodyKind, s: t2.output.state }));
    ok("R-T4 ★ 同一段正文**没有**被复制到另一轮头上(丢数据不可接受,假数据更不可接受)",
      t1.bodyKind === "none" && t1.output.state === "missing" && t1.outcome === "failed",
      JSON.stringify({ o: t1.outcome, k: t1.bodyKind, s: t1.output.state }));
    ok("R-T4 两轮都被结算了(终态不能只收一半)",
      t1.state === "settled" && t2.state === "settled");
    const v = checkDirT(rec.dir);
    ok("R-T4 ★ 终态目录通过独立校验器", v.violations.length === 0, JSON.stringify(v.violations));
    rec.cleanup();
  });

  // ── T5:不给正文时,行为与从前一致(向后兼容,别把老路径改坏) ─────────────
  await withTmp(async () => {
    const rec = createVizRun({ bridgeVersion: "t", env: on() });
    rec.sessionOpened({ sessionId: "s1", agent: "omp" });
    const a = rec.attempt({ sessionId: "s1", input: "x" });
    rec.dispatch(a, { boundary: "rpc_ack" });
    rec.markSessionTerminal("s1", { outcome: "failed", error: "dead" });
    await settleIo(rec);
    const t = turnsOf(latest(rec.dir), "s1")[0];
    ok("R-T5 不带正文的终态仍是 failed + none(老调用点不受影响)",
      t.outcome === "failed" && t.bodyKind === "none" && t.state === "settled",
      JSON.stringify({ o: t.outcome, k: t.bodyKind, st: t.state }));
    rec.cleanup();
  });

  // ── T6:归一化对 `aborted` 生效 —— 中断的轮次不许自称 final ────────────────
  // 桥侧现在按 `status` 优先映射 outcome(用户 abort 时 err 为空,只看 err 会记成 completed)。
  // 万一某个结算点漏了这一步、传上来 aborted + final,writer 这道归一必须兜住。
  await withTmp(async () => {
    const rec = createVizRun({ bridgeVersion: "t", env: on() });
    rec.sessionOpened({ sessionId: "s1", agent: "claude" });
    const a = rec.attempt({ sessionId: "s1", input: "x" });
    rec.dispatch(a, { boundary: "pipe_enqueued" });
    rec.settleOnce(a, { outcome: "aborted", body: "被打断前写到这儿", bodyKind: "final" });
    await settleIo(rec);
    const t = turnsOf(latest(rec.dir), "s1")[0];
    ok("R-T6 ★ aborted + final 被归一成 aborted + partial(§4.9 矩阵里 final 只配 completed)",
      t.outcome === "aborted" && t.bodyKind === "partial",
      JSON.stringify({ o: t.outcome, k: t.bodyKind }));
    ok("R-T6 正文本身不丢(降的是标签,不是内容)", t.output.state === "ready");
    rec.cleanup();
  });
}

console.log(`\n========================================================`);
console.log(`  repro-viz-writer: ${pass} passed, ${fail} failed`);
console.log(`========================================================\n`);
process.exit(fail ? 1 : 0);
