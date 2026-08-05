// 端到端验收：观测台「追问」从 inbox 文件一路走到真桥进程里的 `sendFollowupFromViz`。
// 零真实模型消耗，全程 fake-omp（跟 tests/repro-uncollected.mjs 同一套假后端）。
//
// 要证明的是 docs/DESIGN-session-viz-send-lock-2026-08-04.md §4 那句话——
// 「权威闸门在桥进程里,不在页面」——是不是真的挡住了：
//   ① 有没取走的结果时,追问被拒绝(不许覆盖主 agent 还没看到的答案)
//   ② 会话正忙时,追问被拒绝(复用 session.send() 自己的 busy 闸,不是另一套判据)
//   ③ 正常情况下追问会成功,而且在归档里带着 source:"user_followup" 这个标记
//
// 这三条任何一条只用 repro-viz-inbox.mjs(handler 是假的)或 repro-viz-send-lock.mjs
// (根本没有真桥)都证明不了——两边都得是真的,才是真的把线接通了。
//
// 跑法：node tests/repro-viz-followup-gate.mjs

import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(HERE, "../scripts/agent-bridge.mjs");
const CWD = path.resolve(HERE, "..");
const FAKE = path.join(HERE, process.platform === "win32" ? "fake-omp.cmd" : "fake-omp.sh");
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "followupgate-"));

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`); }
}
const sect = t => console.log(`\n── ${t} ───────────────────────────────`);

/** 后端**收到过几条 prompt**(fake-omp 自己写的单调计数)。
 *
 *  ⚠️ 这是负向用例里最硬的那把尺子。「被保护的答案还在」型断言天生偏弱,实测过两种绕法:
 *    · 后端每轮吐一样的正文时(turnstate),覆盖了 `includes(...)` 照样成立;
 *    · OMP 在歧义轮次里不重置正文累加器,第三发是**追加**不是覆盖,`includes(_2)` 也照样成立。
 *  计数器量的是"后端到底被派了几次活",这两种都盖得住。 */
let counterSeq = 0;
function promptCount(file) {
  try { return Number(fs.readFileSync(file, "utf8").trim()) || 0; } catch { return 0; }
}

/** 读计数,但**先跨一次后端 RPC 往返**当屏障。
 *
 *  ⚠️ 不加屏障的话「计数没涨」是个**会偶尔误绿**的断言,而且失败方向最坏(该红的变绿)。
 *  竞态是这样的:一个 fire-and-forget 的变异(`void session.request("prompt", …)` 之后立刻抛错)
 *  已经把字节**同步写进**子进程 stdin,但假后端进程**还没被调度**去处理它;桥这边紧接着就把
 *  `ok:false` 的回执写出来了,轮询 60ms 内就能读到 —— 这时候去读计数,拿到的还是旧值。
 *  之后假后端才执行 `notePrompt()`。
 *
 *  屏障靠的是 **FIFO**,不是 sleep(sleep 只是把竞态窗口挪一挪):`agent_bridge_status(sid)` 会往
 *  **同一条 stdin** 发 `get_state`,而假后端是单线程按行处理的 —— 排在前面的那条 prompt 必然
 *  先被处理完(`notePrompt()` 是同步写文件),它的响应才轮得到发出来。所以只要这次 status 回来了,
 *  更早写进去的 prompt 就一定已经记上账了。
 *
 *  ⚠️⚠️ **屏障自己失败时必须当场炸,绝不能"吞掉然后照常读计数"。** 那等于把误绿窗口从
 *  「没有屏障」缩小成「屏障失败的那一支」——方向没变,还更难发现。而且失败有**两种形状**:
 *  `call()` 会在超时/进程已退出时**抛异常**,也会把 JSON-RPC / tool 错误**正常返回**成
 *  `{isError:true}` —— 只 try/catch 只盖住前一种。两种都要判,而且还要确认回来的是**这个会话**。 */
async function countAfterBarrier(call, sid, counterFile) {
  const barrier = await call("agent_bridge_status", { session_id: sid }, 10000);
  if (barrier?.isError || barrier?.payload?.session?.id !== sid) {
    throw new Error(`backend barrier failed (计数读数不可信): ${JSON.stringify(barrier).slice(0, 200)}`);
  }
  return promptCount(counterFile);
}

/** 起一个真 MCP server,跑一段,收干净(跟 repro-uncollected.mjs 同款,自成一份不共享)。
 *  `fn` 会拿到 `counterFile`:随时 `promptCount(counterFile)` 就知道后端被派了几次活。 */
async function withServer(mode, fn, extraEnv = {}) {
  const counterFile = path.join(STATE_DIR, `promptcount-${++counterSeq}.txt`);
  const srv = spawn("node", [BRIDGE, "mcp"], {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    env: {
      ...process.env, OMP_BIN: FAKE, FAKE_OMP_MODE: mode,
      AGENT_BRIDGE_STATE_DIR: STATE_DIR, FAKE_OMP_COUNTER_FILE: counterFile, ...extraEnv,
    },
  });
  let exited = null;
  srv.on("close", (code, signal) => { exited = { code, signal }; });
  srv.stderr.on("data", () => {});
  const responses = new Map();
  let buf = "";
  srv.stdout.on("data", d => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      try { const m = JSON.parse(line); if (m.id !== undefined) responses.set(m.id, m); } catch {}
    }
  });
  let nextId = 1;
  const rpc = o => srv.stdin.write(JSON.stringify(o) + "\n");
  async function call(name, args, timeoutMs = 30000) {
    const id = nextId++;
    rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (responses.has(id)) {
        const r = responses.get(id);
        if (r.error) return { payload: null, rpcError: r.error, isError: true };
        const t = r.result?.content?.[0]?.text;
        let payload = null;
        try { payload = t ? JSON.parse(t) : null; } catch { payload = t; }
        return { payload, rpcError: null, isError: r.result?.isError === true };
      }
      if (exited) throw new Error("server exited mid-call");
      await sleep(30);
    }
    throw new Error(`${name} timed out after ${timeoutMs}ms`);
  }
  rpc({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
  await sleep(200);
  try {
    return await fn({ call, srv, counterFile });
  } finally {
    try { srv.stdin.end(); } catch {}
    for (let i = 0; i < 60 && !exited; i++) await sleep(100);
    try { srv.kill("SIGKILL"); } catch {}
  }
}

/** 按 pid 找这个桥进程自己建的 viz run 目录(跟 USAGE.md 教用户手动找的办法一样)。 */
async function findVizDir(bridgePid, timeoutMs = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const names = await fsp.readdir(os.tmpdir()).catch(() => []);
    for (const name of names) {
      if (!name.startsWith("agent-bridge-viz-")) continue;
      const dir = path.join(os.tmpdir(), name);
      try {
        const meta = JSON.parse(await fsp.readFile(path.join(dir, "meta.json"), "utf8"));
        if (meta.pid === bridgePid) return dir;
      } catch {}
    }
    await sleep(50);
  }
  return null;
}

async function writeInboxReq(vizDir, sessionId, reqId, message) {
  const dir = path.join(vizDir, "inbox", sessionId);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, `req-${reqId}.json`), JSON.stringify({ message }));
}

async function waitOutbox(vizDir, sessionId, reqId, timeoutMs = 5000) {
  const p = path.join(vizDir, "outbox", sessionId, `resp-${reqId}.json`);
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fs.existsSync(p)) {
      try { return JSON.parse(await fsp.readFile(p, "utf8")); } catch {}
    }
    await sleep(60);
  }
  return null;
}

async function latestSnapshot(vizDir) {
  const slots = await Promise.all([0, 1].map(async i => {
    try { return JSON.parse(await fsp.readFile(path.join(vizDir, `state.${i}.json`), "utf8")); }
    catch { return null; }
  }));
  const valid = slots.filter(Boolean);
  if (!valid.length) return null;
  return valid.reduce((a, b) => (a.generation > b.generation ? a : b));
}

/* ============================================================ */
async function t1_uncollected_gate_blocks_followup() {
  sect("T1 ★ 有没取走的结果时,追问被桥拒绝——权威闸门真的挡住了");
  await withServer("okturn", async ({ call, srv, counterFile }) => {
    const vizDir = await findVizDir(srv.pid);
    ok("T1 找到了这个桥进程的 viz 目录", !!vizDir, String(vizDir));
    if (!vizDir) return;

    const { payload: opened } = await call("agent_bridge_open_session", { agent: "omp", cwd: CWD });
    const sid = opened.session.id;
    await call("agent_bridge_send_message", { session_id: sid, message: "hi" });
    await sleep(1200); // okturn:让这一轮真的结算,但**不去 collect**

    // 拒绝之前先把「要保护的东西」原样记下来,拒绝之后逐个比对。
    const { payload: stBefore } = await call("agent_bridge_status", { session_id: sid });
    const protectedTurnId = stBefore?.session?.lastTurn?.id ?? null;
    ok("T1 前提:确实有一轮没被取走的产出", !!protectedTurnId, JSON.stringify(stBefore?.session?.lastTurn));
    const beforeCount = promptCount(counterFile);
    ok("T1 前提:后端此前只被派过一次活", beforeCount === 1, String(beforeCount));

    await writeInboxReq(vizDir, sid, "gate-r1", "追问一下");
    const resp = await waitOutbox(vizDir, sid, "gate-r1");
    ok("T1 outbox 回执写出来了", !!resp, JSON.stringify(resp));
    ok("T1 ★ ok:false——被挡住了", resp?.ok === false, JSON.stringify(resp));
    ok("T1 错误信息点名 uncollected 这件事", /collect/i.test(resp?.error || ""), resp?.error);
    // ★★ 断言**被保护的副作用没有发生**,而不是只看回执长什么样。
    // ⚠️ 这里不能只查「这个会话还欠着某一笔」——**追问真的执行了的话,它自己那一轮也会挂上账**,
    //    于是 `.some(sessionId === sid)` 照样为真,这条断言就完全没有牙。必须钉死是**同一笔**:
    //    turnId 没变、正文没变。
    // ⚠️ **最硬的那把尺子放在最前面**:下面几条(债务 id / 末轮 id / 正文还在)都存在同一个
    //    绕法 —— 产品直接调底层 `session.request("prompt", …)`、不理会 ACK 也不铸 id,再抛出
    //    原来那句拒绝错误:prompt **真的送到后端了**,而 id 没变、正文没变、债务也没变,三条全绿。
    //    只有"后端被派了几次活"照得出来(实测:那个变异下只有 ★★ 这条红)。
    //    ⚠️ 读计数必须走 `countAfterBarrier`,直接读会**偶尔误绿**(见那个函数的说明)。
    const afterCount = await countAfterBarrier(call, sid, counterFile);
    ok("T1 ★★ 后端一次都没有被再派活(计数没涨)", afterCount === beforeCount,
      `${beforeCount} → ${afterCount}`);
    const { payload: stAfter } = await call("agent_bridge_status", {});
    const debt = (stAfter?.uncollected || []).find(x => x.sessionId === sid);
    ok("T1 ★ 被拒之后,挂在账上的还是原来那一笔(turnId 一个字没变,不是被新一轮顶替)",
      !!debt && debt.turnId === protectedTurnId, JSON.stringify({ debt, protectedTurnId }));
    // 末轮 id 没变 —— **辅助证据,不是判据**(raw-request 那条绕法下它照样成立)。
    // **必须在 `result` 之前查**:`result` 自己就是一次交付,查完账就没了。
    const { payload: stTurn } = await call("agent_bridge_status", { session_id: sid });
    ok("T1 ★ 末轮 id 没变", stTurn?.session?.lastTurn?.id === protectedTurnId,
      JSON.stringify(stTurn?.session?.lastTurn));
    const { payload: gotAfter } = await call("agent_bridge_result", { session_id: sid });
    ok("T1 ★ 原来那份答案原样取得回来",
      typeof gotAfter?.text === "string" && gotAfter.text.includes("OKTURN_ANSWER"), JSON.stringify(gotAfter?.text));

    // 收掉之后再追问一次,应该能过——证明闸门挡的是"没收"这件事本身,不是别的什么。
    await call("agent_bridge_wait", { session_ids: [sid], timeout_ms: 20000 });
    await writeInboxReq(vizDir, sid, "gate-r2", "现在应该能问了");
    const resp2 = await waitOutbox(vizDir, sid, "gate-r2");
    ok("T1 ★ 收完之后同一个会话的追问改为 ok:true", resp2?.ok === true, JSON.stringify(resp2));

    await call("agent_bridge_close_session", { session_id: sid });
  });
}

async function t2_busy_gate_reuses_send_own_check() {
  sect("T2 会话正忙时,追问被拒绝");
  await withServer("slowturn", async ({ call, srv, counterFile }) => {
    const vizDir = await findVizDir(srv.pid);
    if (!vizDir) { ok("T2 找到了 viz 目录", false); return; }

    const { payload: opened } = await call("agent_bridge_open_session", { agent: "omp", cwd: CWD });
    const sid = opened.session.id;
    await call("agent_bridge_send_message", { session_id: sid, message: "hi" });
    await sleep(500); // slowturn:这一轮会一直 running,不会自己结束

    const { payload: stBefore } = await call("agent_bridge_status", { session_id: sid });
    const runningTurnId = stBefore?.session?.lastTurn?.id ?? null;
    ok("T2 前提:确实有一轮正在跑", !!runningTurnId && stBefore?.session?.status === "running",
      JSON.stringify({ runningTurnId, status: stBefore?.session?.status }));
    const beforeCount = promptCount(counterFile);
    ok("T2 前提:后端此前只被派过一次活", beforeCount === 1, String(beforeCount));

    await writeInboxReq(vizDir, sid, "busy-r1", "趁它还在跑的时候问一句");
    const resp = await waitOutbox(vizDir, sid, "busy-r1");
    ok("T2 outbox 回执写出来了", !!resp, JSON.stringify(resp));
    ok("T2 ★ ok:false——忙着的时候被挡住", resp?.ok === false, JSON.stringify(resp));
    // ⚠️ 文案**故意**不区分「还在跑」与「跑完没人取」——见 sendFollowupFromViz 的说明:
    //    这两者本来就分不可靠,而正确处置都是拒绝,所以话要对两种情况同时成立。
    ok("T2 错误信息说的是「可能还握着没被取走的答案」(对两种情形都为真)",
      /collect/i.test(resp?.error || "") && /still be running/i.test(resp?.error || ""), resp?.error);
    // ★★ 只查回执 = 没牙:「先真的发出去、再抛出预期的拒绝错误」这个变异下上面几条照样全绿。
    //    而「id 没变 / 归档没多一轮」也不够 —— 产品若直接调底层 `request("prompt", …)`、
    //    不理 ACK 不铸 id,那两条同样照样成立。判据只能是**后端被派了几次活**。
    const afterCount = await countAfterBarrier(call, sid, counterFile);
    ok("T2 ★★ 后端一次都没有被再派活(计数没涨)", afterCount === beforeCount,
      `${beforeCount} → ${afterCount}`);
    const { payload: stAfter } = await call("agent_bridge_status", { session_id: sid });
    ok("T2 ★ 被拒之后还是原来那一轮在跑",
      stAfter?.session?.lastTurn?.id === runningTurnId, JSON.stringify(stAfter?.session?.lastTurn));
    const snapT2 = await latestSnapshot(vizDir);
    const sessT2 = snapT2?.sessions?.find(s => s.sessionId === sid);
    ok("T2 ★ 归档里这个会话仍然只有一轮", (sessT2?.turns || []).length === 1,
      JSON.stringify((sessT2?.turns || []).map(t => t.turnNo)));

    await call("agent_bridge_close_session", { session_id: sid, force: true });
  });
}

async function t2b_stale_running_must_not_bypass_the_gate() {
  sect("T2b ★★ OMP 已知的「假 running」状态下,闸门绝不能被绕过(否则未取的答案就被覆盖了)");
  // turnstate 模式:先**真正跑完**一轮(agent_end 发出、turnInFlight 清掉、结束戳写入),
  // 随后 get_state 单方面开始报 isStreaming:true —— 桥的 status 会被翻回 "running"。
  // 这时 `sessionSettled()` 为假,而 `send()` 那边只看 turnInFlight(早清了)⇒ 会接受。
  // 第一版闸门写成「说不清算没结算就跳过检查」,正好在这个形状上整道闸失效。
  await withServer("turnstate", async ({ call, srv, counterFile }) => {
    const vizDir = await findVizDir(srv.pid);
    if (!vizDir) { ok("T2b 找到了 viz 目录", false); return; }

    const { payload: opened } = await call("agent_bridge_open_session", { agent: "omp", cwd: CWD });
    const sid = opened.session.id;
    await call("agent_bridge_send_message", { session_id: sid, message: "这一轮的答案不许被弄丢" });
    // 等它真跑完 + 等 get_state 翻成 isStreaming:true。**全程不 collect**。
    await sleep(1600);
    // status 会调 refreshStatus() → state() → 把 status 翻成陈旧的 "running"。
    const { payload: st } = await call("agent_bridge_status", { session_id: sid });
    ok("T2b 前提:状态确实被陈旧读数翻成了 running(否则这条是空考)",
      st?.session?.status === "running", JSON.stringify(st?.session?.status));

    const beforeCount = promptCount(counterFile);
    const beforeTurnId = st?.session?.lastTurn?.id ?? null;
    ok("T2b 前提:后端此前只被派过一次活", beforeCount === 1, String(beforeCount));

    await writeInboxReq(vizDir, sid, "stale-r1", "趁着状态自相矛盾的时候插一句");
    const resp = await waitOutbox(vizDir, sid, "stale-r1");
    ok("T2b ★★ 追问被拒绝(闸门没有被陈旧状态绕过)", resp?.ok === false, JSON.stringify(resp));

    // ⚠️ **这里不能只断言「答案还在」。** turnstate 每一发都吐**同一句** `TURNSTATE_ANSWER`,
    //    所以"先真的发出去、等它 60ms 后吐出一模一样的正文、再抛预期拒绝错误"这个变异下,
    //    `includes("TURNSTATE_ANSWER")` 照样成立 —— 原答案其实已经被第二轮覆盖了。
    //    真正钉死副作用的是**后端被派了几次活**,以及末轮 id 有没有变。
    const afterCount = await countAfterBarrier(call, sid, counterFile);
    ok("T2b ★★ 后端一次都没有被再派活(计数没涨)", afterCount === beforeCount,
      `${beforeCount} → ${afterCount}`);
    const { payload: stAfter } = await call("agent_bridge_status", { session_id: sid });
    ok("T2b ★★ 末轮 id 没变(没有新一轮顶掉它)",
      stAfter?.session?.lastTurn?.id === beforeTurnId, JSON.stringify(stAfter?.session?.lastTurn));
    const { payload: got } = await call("agent_bridge_result", { session_id: sid });
    ok("T2b ★ 原来那份未取走的答案仍然取得回来", typeof got?.text === "string" && got.text.includes("TURNSTATE_ANSWER"),
      JSON.stringify(got?.text));

    await call("agent_bridge_close_session", { session_id: sid, force: true });
  });
}

async function t2c_never_used_session_is_not_a_followup() {
  sect("T2c 从来没跑过轮次的空会话:不能从页面发——那不是「追问」,而且可能抢在主 agent 首轮之前");
  await withServer("okturn", async ({ call, srv, counterFile }) => {
    const vizDir = await findVizDir(srv.pid);
    if (!vizDir) { ok("T2c 找到了 viz 目录", false); return; }

    const { payload: opened } = await call("agent_bridge_open_session", { agent: "omp", cwd: CWD });
    const sid = opened.session.id;   // 刻意一轮都不发
    ok("T2c 前提:后端一次都没被派过活", promptCount(counterFile) === 0, String(promptCount(counterFile)));

    await writeInboxReq(vizDir, sid, "empty-r1", "在主 agent 派活之前抢先说话");
    const resp = await waitOutbox(vizDir, sid, "empty-r1");
    ok("T2c ★ 被拒绝", resp?.ok === false, JSON.stringify(resp));
    ok("T2c 说清了原因是「还没有可追问的东西」", /never run a turn/i.test(resp?.error || ""), resp?.error);
    // ★★ 同样不能只查回执,也不能只查「末轮仍是空的」—— 产品若直接调底层 `request("prompt", …)`
    //    而不铸 id,`lastTurn` 照样是 null,但那句抢跑的话**已经送到后端了**。
    ok("T2c ★★ 后端一次都没被派过活(那句抢跑的话一个字都没送出去)",
      (await countAfterBarrier(call, sid, counterFile)) === 0, String(promptCount(counterFile)));
    const { payload: stAfter } = await call("agent_bridge_status", { session_id: sid });
    ok("T2c ★ 会话仍然一轮都没有", !stAfter?.session?.lastTurn, JSON.stringify(stAfter?.session?.lastTurn));

    await call("agent_bridge_close_session", { session_id: sid, force: true });
  });
}

async function t3_successful_followup_tagged_in_archive() {
  sect("T3 ★ 正常追问成功后,归档里这一轮的 source 是 user_followup");
  await withServer("okturn", async ({ call, srv }) => {
    const vizDir = await findVizDir(srv.pid);
    if (!vizDir) { ok("T3 找到了 viz 目录", false); return; }

    const { payload: opened } = await call("agent_bridge_open_session", { agent: "omp", cwd: CWD });
    const sid = opened.session.id;
    await call("agent_bridge_send_message", { session_id: sid, message: "第一轮:主 agent 提的" });
    await sleep(1200);
    await call("agent_bridge_wait", { session_ids: [sid], timeout_ms: 20000 }); // 收掉,不然会撞上 T1 那道闸

    await writeInboxReq(vizDir, sid, "tag-r1", "第二轮:用户在页面上追的");
    const resp = await waitOutbox(vizDir, sid, "tag-r1");
    ok("T3 追问被接受", resp?.ok === true, JSON.stringify(resp));
    await sleep(1200); // 让这第二轮也真的结算,快照才会带上它

    const snap = await latestSnapshot(vizDir);
    const session = snap?.sessions?.find(s => s.sessionId === sid);
    const lastTurn = session?.turns?.[session.turns.length - 1];
    ok("T3 找到了这一轮", !!lastTurn, JSON.stringify(session?.turns?.map(t => t.turnNo)));
    ok("T3 ★ 归档里这一轮的 source 是 user_followup", lastTurn?.source === "user_followup", JSON.stringify(lastTurn));

    // ★★ 归档标对了还不够 —— **主 agent 自己那条路上必须也看得见**。
    //    否则它会看到委托 agent 突然带上一段自己没派过的上下文却完全无法解释,
    //    也就是"按一个自己看不见的东西做判断"。这条只能用真的 wait/result 去考。
    const { payload: stDebt } = await call("agent_bridge_status", {});
    const debt = (stDebt?.uncollected || []).find(x => x.sessionId === sid);
    ok("T3 ★★ 欠账台账上就标着这一轮是用户追问的", debt?.source === "user_followup", JSON.stringify(debt));

    const { payload: w } = await call("agent_bridge_wait", { session_ids: [sid], timeout_ms: 20000 });
    ok("T3 ★★ 主 agent wait 拿到的 lastTurn.source 是 user_followup",
      w?.completed?.lastTurn?.source === "user_followup", JSON.stringify(w?.completed?.lastTurn));

    await call("agent_bridge_close_session", { session_id: sid });
  });
}

async function t4_all_three_sources_really_get_emitted() {
  sect("T4 ★★ 三档 source 每一档都真的被产出过(光校验「值合不合法」查不出「有一档从来没出现过」)");
  await withServer("okturn", async ({ call, srv }) => {
    const vizDir = await findVizDir(srv.pid);
    if (!vizDir) { ok("T4 找到了 viz 目录", false); return; }

    // ① initial_prompt —— 开会话时带首轮。这一档在修复之前**生产里从未出现过**
    //    (开会话那条路漏传 source,全落到默认的 send_message 上)。
    const { payload: opened } = await call("agent_bridge_open_session", {
      agent: "omp", cwd: CWD, initial_prompt: "首轮:开会话时带的",
    });
    const sid = opened.session.id;
    await sleep(1200);
    await call("agent_bridge_wait", { session_ids: [sid], timeout_ms: 20000 });

    // ② send_message —— 调用方自己发的
    await call("agent_bridge_send_message", { session_id: sid, message: "第二轮:主 agent 发的" });
    await sleep(1200);
    await call("agent_bridge_wait", { session_ids: [sid], timeout_ms: 20000 });

    // ③ user_followup —— 页面上追问的
    await writeInboxReq(vizDir, sid, "src-r1", "第三轮:用户追的");
    const resp = await waitOutbox(vizDir, sid, "src-r1");
    ok("T4 追问被接受", resp?.ok === true, JSON.stringify(resp));
    await sleep(1200);

    const snap = await latestSnapshot(vizDir);
    const session = snap?.sessions?.find(s => s.sessionId === sid);
    const sources = (session?.turns || []).map(t => t.source);
    ok("T4 ★★ 首轮真的被标成 initial_prompt(修复前这里是 send_message)",
      sources[0] === "initial_prompt", JSON.stringify(sources));
    ok("T4 第二轮是 send_message", sources[1] === "send_message", JSON.stringify(sources));
    ok("T4 第三轮是 user_followup", sources[2] === "user_followup", JSON.stringify(sources));
    ok("T4 ★ 三档齐了(枚举里没有一档是死的)",
      new Set(sources).size === 3, JSON.stringify(sources));

    await call("agent_bridge_close_session", { session_id: sid });
  });
}

async function t5_ambiguous_turn_without_id_must_not_bypass_the_gate() {
  sect("T5 ★★ 「送出去了但没铸出 turn id」的歧义轮次:闸门绝不能被上一轮的旧证明放行");
  // 这是 T2b 的**同根异路**。T2b 那条是状态读数陈旧;这条是 **id 压根没铸出来**:
  //   `lastTurnId` 只在后端确认收下 prompt 之后才铸(见各后端 send() 的 "stamp the turn now")。
  //   OMP 的 RPC ACK 超时明确被记为 ambiguous —— 桥自己写着「不证明后端没收下那条 prompt」——
  //   却会清掉 turnInFlight、把 status 放回 idle。于是留下这么个局面:
  //     后端正跑着第二轮,而 `lastTurnId` 还是**第一轮**的 id,
  //     跟第一轮那份"已取走"的证明严丝合缝地对上 ⇒ 只比 turnId 的闸门必然放行 ⇒ 第二轮答案被覆盖。
  // 修法是送轮次代际 `sendEpoch`:任何一次"可能送达后端"的尝试都 +1,证明连代际一起记。
  // ⚠️ 变异判据:把 `dischargeProofValid()` 里那句 epoch 比较删掉,下面带 ★★ 的两条必须变红。
  await withServer("ackless", async ({ call, srv, counterFile }) => {
    const vizDir = await findVizDir(srv.pid);
    if (!vizDir) { ok("T5 找到了 viz 目录", false); return; }

    const { payload: opened } = await call("agent_bridge_open_session", { agent: "omp", cwd: CWD });
    const sid = opened.session.id;

    // 第一轮:正常一来一回,而且**真的收掉** ⇒ 留下一份合法的"已取走"证明。
    await call("agent_bridge_send_message", { session_id: sid, message: "第一轮:正常的" });
    await call("agent_bridge_wait", { session_ids: [sid], timeout_ms: 20000 });
    const { payload: st1 } = await call("agent_bridge_status", { session_id: sid });
    const firstTurnId = st1?.session?.lastTurn?.id ?? null;
    ok("T5 前提:第一轮有 id 且已被收走", !!firstTurnId, JSON.stringify(st1?.session?.lastTurn));

    // 第二轮:ack 被后端吞掉 ⇒ 桥这边 RPC 超时 ⇒ 判 ambiguous。但那一轮**照跑照出答案**。
    const r2 = await call("agent_bridge_send_message", { session_id: sid, message: "第二轮:ack 会超时" });
    ok("T5 前提:第二发确实以 ACK 超时告终(桥自己也说不清后端收没收)",
      r2.isError === true || /no response/i.test(JSON.stringify(r2.payload ?? "")), JSON.stringify(r2).slice(0, 200));

    await sleep(1500); // 让那一轮真的把正文吐完

    const { payload: st2 } = await call("agent_bridge_status", { session_id: sid });
    // ★ 这条是整个用例的**要害前提**:末轮 id 停在第一轮上。也就是说,一个只比 turnId 的闸门
    //   此刻拿到的是「末轮 = 第一轮,而第一轮已取走」—— 必然放行。前提不成立这条就是空考。
    ok("T5 ★ 要害前提:歧义轮次没有铸出自己的 id,末轮 id 仍停在第一轮上",
      st2?.session?.lastTurn?.id === firstTurnId, JSON.stringify({ now: st2?.session?.lastTurn?.id, firstTurnId }));

    const beforeCount = promptCount(counterFile);
    ok("T5 前提:后端此前被派过两次活", beforeCount === 2, String(beforeCount));

    await writeInboxReq(vizDir, sid, "amb-r1", "趁桥分不清的时候插一句");
    const resp = await waitOutbox(vizDir, sid, "amb-r1");
    ok("T5 ★★ 追问被拒绝(旧证明没能把这一轮放过去)", resp?.ok === false, JSON.stringify(resp));

    // ★★ 真正要守的东西:**第三轮从来没发生过**。只断言"回执是 ok:false"证明不了 ——
    //    先真的发出去再抛错,回执照样是 ok:false(这条实测过)。
    ok("T5 ★★ 后端没有被派第三次活(追问一个字都没送出去)",
      (await countAfterBarrier(call, sid, counterFile)) === beforeCount,
      `${beforeCount} → ${promptCount(counterFile)}`);
    const { payload: got } = await call("agent_bridge_result", { session_id: sid });
    const text = typeof got?.text === "string" ? got.text : "";
    ok("T5 ★ 歧义轮次那份没人取的答案仍然取得回来", text.includes("ACKLESS_ANSWER_2"), text.slice(0, 200));

    await call("agent_bridge_close_session", { session_id: sid, force: true });
  }, { AGENT_BRIDGE_OMP_RPC_TIMEOUT_MS: "1500" }); // 别让这条用例干等默认的 10 秒
}

async function t6_discharge_proof_must_not_be_washed_by_a_midflight_read() {
  sect("T6 ★★ 歧义轮次跑着的时候中途取一次结果,不许把「已交付」的证明洗成当前代际");
  // 这是 T5 的**更深一层**,也是"看起来比了代际、其实没比对东西"的典型:
  //   第一版把代际记进 DISCHARGED(交付时读当时的 sendEpoch)。歧义轮次正跑着时,
  //   `result` **允许**中途取快照(拿到的还是旧 id),collectDeliveries 于是写出
  //   `{turnId: 旧id, epoch: 当前代}` —— 证明被洗成当前代际,闸门当场重新打开。
  //   修法:代际的两侧操作数都必须是**会话自己的**计数器(lastTurnEpoch vs sendEpoch),
  //   交付这个动作碰不到它们。
  // ⚠️ 变异判据:把 `dischargeProofValid()` 末行换回「比 DISCHARGED 里记的 epoch」,
  //    并让 `dischargeTurn()` 重新记 `epoch: session.sendEpoch`,下面带 ★★ 的两条必须变红。
  await withServer("ackless-slow", async ({ call, srv, counterFile }) => {
    const vizDir = await findVizDir(srv.pid);
    if (!vizDir) { ok("T6 找到了 viz 目录", false); return; }

    const { payload: opened } = await call("agent_bridge_open_session", { agent: "omp", cwd: CWD });
    const sid = opened.session.id;

    await call("agent_bridge_send_message", { session_id: sid, message: "第一轮:正常的" });
    await call("agent_bridge_wait", { session_ids: [sid], timeout_ms: 20000 });
    const { payload: st1 } = await call("agent_bridge_status", { session_id: sid });
    const firstTurnId = st1?.session?.lastTurn?.id ?? null;
    ok("T6 前提:第一轮有 id 且已被收走", !!firstTurnId, JSON.stringify(st1?.session?.lastTurn));

    // 第二轮:ack 被吞 ⇒ 1.5s 后超时;正文要到 3s 才吐 ⇒ 中间有一段「后端还在跑、桥已判 idle」的真空。
    const r2 = await call("agent_bridge_send_message", { session_id: sid, message: "第二轮:ack 会超时,而且跑得慢" });
    ok("T6 前提:第二发以 ACK 超时告终", r2.isError === true, JSON.stringify(r2).slice(0, 160));

    // ★ 就在真空里中途取一次结果 —— 这一步就是"洗证明"的动作本身。
    const { payload: mid } = await call("agent_bridge_result", { session_id: sid });
    ok("T6 前提:真空里取到的还是**旧**答案(歧义轮次还没吐正文,否则洗不了、这条就是空考)",
      !!mid && !String(mid?.text ?? "").includes("ACKLESS_SLOW_ANSWER_2"),
      JSON.stringify({ text: String(mid?.text ?? "").slice(0, 80) }));
    // 「旧 id」要**显式**断言,不能靠"正文里没有 _2"间接推断(那只说明正文还没到)。
    const { payload: stMid } = await call("agent_bridge_status", { session_id: sid });
    ok("T6 前提:此刻末轮 id 仍然停在第一轮上(这才是「证明能被洗」的前提)",
      stMid?.session?.lastTurn?.id === firstTurnId,
      JSON.stringify({ now: stMid?.session?.lastTurn?.id, firstTurnId }));

    const beforeCount = promptCount(counterFile);
    ok("T6 前提:后端此前被派过两次活", beforeCount === 2, String(beforeCount));

    await writeInboxReq(vizDir, sid, "wash-r1", "趁证明刚被洗过的时候插一句");
    const resp = await waitOutbox(vizDir, sid, "wash-r1");
    ok("T6 ★★ 追问仍然被拒绝(中途那次交付没能把闸门重新打开)", resp?.ok === false, JSON.stringify(resp));
    // ⚠️ **这条才是本用例真正有牙的那一条**(退回旧写法时,只有这一类断言会红)。
    //    「那份答案还在」型断言在这里天生偏弱:歧义轮次没铸新 id ⇒ 正文累加器从没重置 ⇒
    //    第三发的正文是**追加**而不是覆盖,`includes(_2)` 照样成立。
    ok("T6 ★★ 后端没有被派第三次活", (await countAfterBarrier(call, sid, counterFile)) === beforeCount,
      `${beforeCount} → ${promptCount(counterFile)}`);

    await sleep(3200); // 等歧义轮次把正文吐完
    const { payload: got } = await call("agent_bridge_result", { session_id: sid });
    const text = typeof got?.text === "string" ? got.text : "";
    ok("T6 ★ 歧义轮次那份答案还在", text.includes("ACKLESS_SLOW_ANSWER_2"), text.slice(0, 200));

    await call("agent_bridge_close_session", { session_id: sid, force: true });
  }, { AGENT_BRIDGE_OMP_RPC_TIMEOUT_MS: "1500" });
}

async function t7_earlier_send_must_not_claim_a_later_ambiguous_epoch() {
  sect("T7 ★★ 并发窗口(第二发若进去会「下落不明」):必须在漏斗层就关上");
  // 这是 T5/T6 之后的**并发**那一层。窗口本身是真的:
  //   · A 用 wait:true 发,轮次跑完(agent_end 一到,桥就把 turnInFlight 清了),
  //     但 A 还卡在 result() 里读最终正文(fake 拖 4 秒)—— **A 的 sendTurn 还没走到 finally**;
  //   · 这段时间里各后端自己的 busy 闸**拦不住**第二发(它看的就是 turnInFlight)。
  // 放第二发进去的话,不管它是什么结局都已经错了 —— **它真的被派给后端了**,而这正是要防的事:
  //   ㈠ 它下落不明(本用例的 ackless 形状)⇒ 代际上留下一个说不清的缺口;
  //   ㈡ 它成功铸出自己的 id(见 T8 的 slowtext-ok 形状)⇒ 它可能顶掉先来那一轮还没被取走的产出。
  // 所以处置不是"在 finally 里小心点",而是**当场拒、且拒在 sendEpoch 动之前**。
  // 这两条用例分别钉住㈠㈡两种结局:去掉漏斗那道拒绝,两条都会红,而且红的是不同的东西。
  // ⚠️ 本用例的变异判据:删掉 `sendTurn()` 开头那道「槽被占着就拒」,下面 ★★ 两条必须变红。
  await withServer("slowtext-ackless", async ({ call, srv, counterFile }) => {
    const vizDir = await findVizDir(srv.pid);
    if (!vizDir) { ok("T7 找到了 viz 目录", false); return; }

    const { payload: opened } = await call("agent_bridge_open_session", { agent: "omp", cwd: CWD });
    const sid = opened.session.id;

    // A:wait:true。**不 await** —— 它会卡在 result() 里约 4 秒,正好给 B 让出窗口。
    const pA = call("agent_bridge_send_message", { session_id: sid, message: "A:wait:true", wait: true }, 30000);
    await sleep(1200);   // 等 A 的轮次跑完、进入 result() 的那段停顿

    // B:趁 A 还没回到 finally 的时候插进来。它的 ack 会被吞 —— 也就是说**万一放它进去**,
    // 它会变成一发"可能已送达、没铸 id"的下落不明,先来的 A 就有机会把那一代当成自己的。
    const rB = await call("agent_bridge_send_message", { session_id: sid, message: "B:抢在 A 收尾之前,而且 ack 会丢" }, 30000)
      .catch(e => ({ isError: true, err: String(e?.message || e) }));
    const rA = await pA.catch(e => ({ isError: true, err: String(e?.message || e) }));
    ok("T7 前提:A 那一发拿到了自己的结果", !!rA && rA.isError !== true, JSON.stringify(rA).slice(0, 160));

    // ★★ 窗口是从**漏斗**这一侧关上的:B 压根没走到后端。判据用最硬的那把尺子 —— 后端被派了几次活。
    ok("T7 ★★ B 在漏斗层就被拒了(说得出「还有一发在途」)",
      rB?.isError === true && /send in flight/i.test(JSON.stringify(rB?.payload ?? rB?.rpcError ?? "")),
      JSON.stringify(rB).slice(0, 200));
    ok("T7 ★★ 后端只收到过一条 prompt —— B 一个字都没送出去",
      (await countAfterBarrier(call, sid, counterFile)) === 1, String(promptCount(counterFile)));

    // 被拒的那一发不许留下后遗症:代际没被平白推进 ⇒ 收走 A 之后闸门要肯放行。
    // ⚠️ 这里**不能**断言追问 `ok:true`:这个模式的假后端故意吞掉第 2 条 prompt 的 ack,
    //    所以追问一定会以 RPC 超时收场 —— 那是测试桩的行为,不是闸门的。
    //    「闸门没锁死」的证据是**请求真的被放到后端去了**(计数涨了)。
    //    追问能不能真正成功由 T8(slowtext-ok)负责。
    await call("agent_bridge_result", { session_id: sid });
    await writeInboxReq(vizDir, sid, "conc-r1", "A 收完了,闸门应该肯放行");
    await waitOutbox(vizDir, sid, "conc-r1");
    ok("T7 ★ 被拒的并发发送没有把闸门锁死(收完 A 之后请求被放行到后端)",
      promptCount(counterFile) === 2, String(promptCount(counterFile)));

    await call("agent_bridge_close_session", { session_id: sid, force: true });
  }, { AGENT_BRIDGE_OMP_RPC_TIMEOUT_MS: "1500" });
}

async function t8_concurrent_send_is_refused_at_the_funnel_and_does_not_lock_the_gate() {
  sect("T8 ★★ 后一发**能成功铸 id** 的并发窗口:必须在漏斗层就拒,而且事后不许把闸门永久锁死");
  // T7 的镜像。T7 里第二发的 ack 被吞(不铸 id);这一条里第二发**一切正常**,如果放它进去,
  // 它会被真的派给后端并铸出自己的 turn id —— 而先来那一轮的产出可能还没被主 agent 取走,
  // 于是页面追问会被一直拒到下一次成功发送为止。
  // 所以漏斗的处置必须是**当场拒、且一个字都不动**(拒在 sendEpoch +1 之前)。
  // ⚠️ 变异判据:把 sendTurn 开头那道「槽被占着就拒」删掉,下面 ★★ 的两条必须变红。
  await withServer("slowtext-ok", async ({ call, srv, counterFile }) => {
    const vizDir = await findVizDir(srv.pid);
    if (!vizDir) { ok("T8 找到了 viz 目录", false); return; }

    const { payload: opened } = await call("agent_bridge_open_session", { agent: "omp", cwd: CWD });
    const sid = opened.session.id;

    const pA = call("agent_bridge_send_message", { session_id: sid, message: "A:wait:true", wait: true }, 30000);
    await sleep(1200);   // A 的轮次已经跑完,但它还卡在读最终正文里
    const rB = await call("agent_bridge_send_message", { session_id: sid, message: "B:趁 A 收尾之前插进来" }, 30000)
      .catch(e => ({ isError: true, err: String(e?.message || e) }));
    const rA = await pA.catch(e => ({ isError: true, err: String(e?.message || e) }));

    ok("T8 前提:A 那一发拿到了自己的结果", !!rA && rA.isError !== true, JSON.stringify(rA).slice(0, 120));
    ok("T8 ★★ B 被拒了(而且是漏斗层拒的,说得出「还有一发在途」)",
      rB?.isError === true && /send in flight/i.test(JSON.stringify(rB?.payload ?? rB?.rpcError ?? "")),
      JSON.stringify(rB).slice(0, 200));
    ok("T8 ★★ 后端只收到过一条 prompt(B 一个字都没送出去)", (await countAfterBarrier(call, sid, counterFile)) === 1,
      String(promptCount(counterFile)));

    // ★★ 拒了之后**不许留下后遗症**:代际没被平白推进,所以收走 A 那一轮之后追问要能正常发。
    const { payload: st } = await call("agent_bridge_status", { session_id: sid });
    const turnA = st?.session?.lastTurn?.id ?? null;
    ok("T8 前提:末轮就是 A 那一轮", !!turnA, JSON.stringify(st?.session?.lastTurn));
    ok("T8 ★ A 那一轮的 source 没有被弄丢/错配", st?.session?.lastTurn?.source === "send_message",
      JSON.stringify(st?.session?.lastTurn));

    await call("agent_bridge_result", { session_id: sid });   // 收走 A
    await writeInboxReq(vizDir, sid, "conc-ok-r1", "A 收完了,现在应该能追问");
    const resp = await waitOutbox(vizDir, sid, "conc-ok-r1");
    ok("T8 ★★ 一次被拒的并发发送没有把闸门永久锁死(收完 A 之后追问照常通过)",
      resp?.ok === true, JSON.stringify(resp));
    ok("T8 追问确实被派给了后端(计数涨到 2)", promptCount(counterFile) === 2, String(promptCount(counterFile)));

    await call("agent_bridge_close_session", { session_id: sid, force: true });
  });
}

/* ============================================================ */
try {
  await t1_uncollected_gate_blocks_followup();
  await t2_busy_gate_reuses_send_own_check();
  await t2b_stale_running_must_not_bypass_the_gate();
  await t2c_never_used_session_is_not_a_followup();
  await t3_successful_followup_tagged_in_archive();
  await t4_all_three_sources_really_get_emitted();
  await t5_ambiguous_turn_without_id_must_not_bypass_the_gate();
  await t6_discharge_proof_must_not_be_washed_by_a_midflight_read();
  await t7_earlier_send_must_not_claim_a_later_ambiguous_epoch();
  await t8_concurrent_send_is_refused_at_the_funnel_and_does_not_lock_the_gate();
} finally {
  try { fs.rmSync(STATE_DIR, { recursive: true, force: true }); } catch {}
}

console.log(`\n${"=".repeat(56)}\n  repro-viz-followup-gate: ${pass} passed, ${fail} failed\n${"=".repeat(56)}`);
process.exit(fail ? 1 : 0);
