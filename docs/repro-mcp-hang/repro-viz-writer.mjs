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

console.log(`\n========================================================`);
console.log(`  repro-viz-writer: ${pass} passed, ${fail} failed`);
console.log(`========================================================\n`);
process.exit(fail ? 1 : 0);
