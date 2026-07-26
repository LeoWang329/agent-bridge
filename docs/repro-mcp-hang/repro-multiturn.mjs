// Repro/verify: `wait` must never hand back a "this turn finished" result for a session that is
// running again — the TOCTOU between judging settled and assembling the payload.
//
// Real incident (2026-07-25, omp + deepseek-v4-pro): an agentic model splits ONE delegation into
// several internal turns — `turn_end` immediately followed by its own `turn_start`. The bridge clears
// turnInFlight at the first turn_end, so sessionSettled() goes true; but waitSessions judged settled
// BEFORE awaiting summarize(), and summarize() → result() is a real RPC round-trip. The backend
// re-entered a turn inside that window, so wait returned `status:"running"` on a result labelled
// finished, carrying the single character the model had emitted so far. Any caller reading `.text`
// got half a word as "the answer".
//
// Two things are asserted, matching the two fixes:
//   1. wait's payload is never a settled result whose own status is running/starting.
//   2. the answer is the FINAL text, not the fragment from the first internal turn.
// Plus: result() must not resurrect the previous turn's text over the clear that turn_start did
// (the stale write-back at the bottom of OmpRpcSession.result).
//
// Drives FAKE_OMP_MODE=multiturn, which hooks the re-entry onto `get_last_assistant_text` — the RPC
// result() always sends — so the race is DETERMINISTIC, not a timing gamble. Zero real model usage.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(HERE, "../../scripts/agent-bridge.mjs");
const CWD = path.resolve(HERE, "../..");
const FAKE = path.join(HERE, process.platform === "win32" ? "fake-omp.cmd" : "fake-omp.sh");
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "ab-multiturn-"));

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass += 1; console.log(`  [PASS] ${label}`); }
  else { fail += 1; console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`); }
};

const srv = spawn("node", [BRIDGE, "mcp"], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  env: { ...process.env, AGENT_BRIDGE_STATE_DIR: STATE, OMP_BIN: FAKE, FAKE_OMP_MODE: "multiturn" },
});
let exited = null;
srv.on("close", (code, signal) => { exited = { code, signal }; console.log(`[srv-close] code=${code} signal=${signal}`); });
srv.stderr.on("data", d => process.stdout.write(`[srv-stderr] ${d}`));

const responses = new Map();
let buf = "";
srv.stdout.on("data", d => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    try { const m = JSON.parse(line); if (m && m.id !== undefined) responses.set(m.id, m); } catch {}
  }
});
const rpc = o => srv.stdin.write(JSON.stringify(o) + "\n");
let nextId = 1;
async function waitResp(id, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (responses.has(id)) return responses.get(id);
    if (exited) return null;
    await sleep(40);
  }
  return undefined;
}
const parse = resp => { const t = resp?.result?.content?.[0]?.text; return t ? JSON.parse(t) : null; };
const bail = msg => { console.log(`[harness] >>> FAIL: ${msg}`); try { srv.kill("SIGKILL"); } catch {} process.exit(1); };
const call = async (name, args, ms = 30000) => { const id = nextId++; rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }); return parse(await waitResp(id, ms)); };

/** 更毒的一支:后端在**同一次 `get_last_assistant_text` RPC 之内**把整整一轮跑完
 *  (turn_start → 新正文 → turn_end),然后才回复,且回的是**旧**正文。
 *  复核时状态又是 idle —— **只看 settled 的实现在这里会通过**,把旧的半句当答案交出去,
 *  还会把它写进 answerFile。只有同时复核 generation 才拦得住。
 *  这一支需要**另起一个桥进程**(FAKE_OMP_MODE 是进程级环境变量)。 */
async function t3_within_one_rpc() {
  console.log("\n[T3] 后端在一次 RPC 内跑完整轮:settled 又成立,但正文已经不属于这一轮");
  const STATE2 = fs.mkdtempSync(path.join(os.tmpdir(), "ab-multiturn-fast-"));
  const srv2 = spawn("node", [BRIDGE, "mcp"], {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    env: { ...process.env, AGENT_BRIDGE_STATE_DIR: STATE2, OMP_BIN: FAKE, FAKE_OMP_MODE: "multiturn-fast" },
  });
  let gone = null;
  srv2.on("close", (code) => { gone = code; });
  srv2.stderr.on("data", d => process.stdout.write(`[srv2-stderr] ${d}`));
  const resp2 = new Map();
  let b2 = "";
  srv2.stdout.on("data", d => {
    b2 += d.toString();
    let i;
    while ((i = b2.indexOf("\n")) >= 0) {
      const line = b2.slice(0, i).trim(); b2 = b2.slice(i + 1);
      if (!line) continue;
      try { const m = JSON.parse(line); if (m && m.id !== undefined) resp2.set(m.id, m); } catch {}
    }
  });
  let id2 = 1;
  const wait2 = async (id, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (resp2.has(id)) return resp2.get(id); if (gone !== null) return null; await sleep(40); }
    return undefined;
  };
  const call2 = async (name, args, ms = 30000) => {
    const id = id2++;
    srv2.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
    return parse(await wait2(id, ms));
  };
  const ini = id2++;
  srv2.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: ini, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "repro-multiturn-fast", version: "0" } } }) + "\n");
  await wait2(ini, 10000);
  srv2.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const sid2 = (await call2("agent_bridge_open_session", { agent: "omp", cwd: CWD }))?.session?.id;
  ok("会话开起来了", !!sid2);
  if (sid2) {
    await call2("agent_bridge_send_message", { session_id: sid2, message: "go" }, 15000);
    const w2 = await call2("agent_bridge_wait", { session_ids: [sid2], mode: "all", timeout_ms: 20000 }, 30000);
    const r2 = w2?.results?.[0];
    ok("wait 返回了 results", !!r2 && !w2?.timedOut, JSON.stringify(w2).slice(0, 300));
    // ★ 这里就是 P1:旧代码复核 settled 会通过,于是把 "." 当答案交出去
    ok("没有把上一轮的半句当答案交出来", r2?.text !== ".", JSON.stringify(r2?.text));
    ok("拿到的是这一轮的真答案", r2?.text === "MULTITURN_ANSWER", JSON.stringify(r2?.text));
    // ★ codex 指出的第二半:失配的文本连 artifact 都不许落。
    //   ⚠️ 这三条**不能**包在 `if (r2.textRef)` 里 —— 摘掉 wait 侧的 generation 复核后,
    //   result() 自己那道闸会以 persist:false 返回(textRef 为 null),那个写法会把断言静默跳过、假绿。
    //   交付出去的结果必须**带着**可取全文的 artifact,这本身就是契约的一部分。
    ok("交付的结果带着 artifact(textRef 不为空)", !!r2?.textRef, `textRef=${r2?.textRef ?? "null"}`);
    let onDisk = null;
    try { onDisk = r2?.textRef ? fs.readFileSync(r2.textRef, "utf8") : null; } catch {}
    ok("answerFile 里也不是那个半句", onDisk !== ".", JSON.stringify(onDisk));
    ok("answerFile 与返回的正文一致", onDisk === r2?.text, `disk=${JSON.stringify(onDisk)} text=${JSON.stringify(r2?.text)}`);

    // ── T4:直接调 agent_bridge_result(中途查看产出)也不能拿到上一轮的正文 ──────────────────
    //  T3 保不住这条:wait 侧复核不通过时会**再取一遍**,第二遍把污染覆盖掉了。
    //  而 `agent_bridge_result` 是一次性的,没有第二遍 —— 它只由 result() 自己那道 generation 闸保护。
    //  用新会话(每个会话一个独立的假后端进程,phase 状态是干净的),
    //  并且**用 status 轮询等 settle**(status 只发 get_state,不会提前触发那个钩子)。
    console.log("\n[T4] 直接取结果(没有第二次机会)时,也不能拿到上一轮的正文");
    const sid3 = (await call2("agent_bridge_open_session", { agent: "omp", cwd: CWD }))?.session?.id;
    ok("第二个会话开起来了", !!sid3);
    if (sid3) {
      await call2("agent_bridge_send_message", { session_id: sid3, message: "go" }, 15000);
      let settledSeen = false;
      for (let k = 0; k < 40 && !settledSeen; k++) {
        const s = await call2("agent_bridge_status", { session_id: sid3 }, 10000);
        if (s?.session?.status === "idle") settledSeen = true; else await sleep(150);
      }
      ok("第一轮已经结束(状态回到 idle)", settledSeen, "没等到 idle,后面的断言测不到东西");
      const one = await call2("agent_bridge_result", { session_id: sid3 }, 15000);
      ok("没有把上一轮的半句当结果返回", one?.text !== ".", JSON.stringify(one?.text));
      let diskOne = null;
      try { diskOne = one?.textRef ? fs.readFileSync(one.textRef, "utf8") : null; } catch {}
      ok("也没有把半句写进 answerFile", diskOne !== ".", JSON.stringify(diskOne));
    }
    await call2("agent_bridge_close_session", {}, 15000);
  }
  try { srv2.stdin.end(); } catch {}
  await sleep(1200);
  try { srv2.kill("SIGKILL"); } catch {}
  try { fs.rmSync(STATE2, { recursive: true, force: true }); } catch {}
}

/** 迟到的 terminal(属于上一轮、且落在本轮 turn_start **之前**)不得把本轮判成已结束。
 *  OMP 的终止事件不带 turn id,本轮的终止和上一轮迟到的终止在字节上完全一样 —— 唯一能分辨的是:
 *  **我们自己这一轮的终止,前面一定有一个我们看见过的 start**。
 *  桥若信了那个迟到的终止,wait 会把**上一轮**的正文当本轮答案交出去(静默错答,比超时糟得多)。
 *
 *  ⚠️ 只覆盖"落在 start 之前"这一支。"落在 start 之后"的迟到终止仍然分辨不了 —— 那需要
 *  「每个终止都要 get_state 确认」,而实测那样会让 `turnstate` 那类后端(get_state 在 turn_end 后
 *  仍报 isStreaming:true,真实 omp 有此行为)**永远 settle 不了**(repro-waitany 会直接红)。
 *  这是如实标注的已知限制,不是遗漏。 */
async function t5_late_terminal() {
  console.log("\n[T5] 迟到的 terminal(本轮 start 之前)不得把本轮判成已结束");
  const STATE3 = fs.mkdtempSync(path.join(os.tmpdir(), "ab-lateterm-"));
  const srv3 = spawn("node", [BRIDGE, "mcp"], {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    env: { ...process.env, AGENT_BRIDGE_STATE_DIR: STATE3, OMP_BIN: FAKE, FAKE_OMP_MODE: "lateterminal" },
  });
  let gone = null;
  srv3.on("close", (code) => { gone = code; });
  srv3.stderr.on("data", d => process.stdout.write(`[srv3-stderr] ${d}`));
  const resp3 = new Map();
  let b3 = "";
  srv3.stdout.on("data", d => {
    b3 += d.toString();
    let i;
    while ((i = b3.indexOf("\n")) >= 0) {
      const line = b3.slice(0, i).trim(); b3 = b3.slice(i + 1);
      if (!line) continue;
      try { const m = JSON.parse(line); if (m && m.id !== undefined) resp3.set(m.id, m); } catch {}
    }
  });
  let id3 = 1;
  const wait3 = async (id, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (resp3.has(id)) return resp3.get(id); if (gone !== null) return null; await sleep(40); }
    return undefined;
  };
  const call3 = async (name, args, ms = 30000) => {
    const id = id3++;
    srv3.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
    return parse(await wait3(id, ms));
  };
  const ini = id3++;
  srv3.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: ini, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "repro-lateterminal", version: "0" } } }) + "\n");
  await wait3(ini, 10000);
  srv3.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const sid = (await call3("agent_bridge_open_session", { agent: "omp", cwd: CWD }))?.session?.id;
  ok("会话开起来了", !!sid);
  if (sid) {
    // 第一轮:正常拿到 FIRST_ANSWER
    await call3("agent_bridge_send_message", { session_id: sid, message: "one" }, 15000);
    const w1 = await call3("agent_bridge_wait", { session_ids: [sid], mode: "all", timeout_ms: 20000 }, 30000);
    ok("第一轮拿到 FIRST_ANSWER", w1?.results?.[0]?.text === "FIRST_ANSWER", JSON.stringify(w1?.results?.[0]?.text));

    // 第二轮:开头先来一个迟到的 agent_end(带上一轮的错误)。桥若信它 → 会把 FIRST_ANSWER 当成第二轮的答案
    await call3("agent_bridge_send_message", { session_id: sid, message: "two" }, 15000);
    const w2 = await call3("agent_bridge_wait", { session_ids: [sid], mode: "all", timeout_ms: 20000 }, 30000);
    const r = w2?.results?.[0];
    ok("wait 返回了 results", !!r && !w2?.timedOut, JSON.stringify(w2).slice(0, 300));
    ok("没有把上一轮的答案当成本轮的", r?.text !== "FIRST_ANSWER", JSON.stringify(r?.text));
    ok("拿到的是本轮的答案", r?.text === "SECOND_ANSWER", JSON.stringify(r?.text));

    // 那条迟到的 agent_end 带着**上一轮的错误**。归属判定必须跑在任何请求级写入之前,否则
    // "先把 lastError 写了、再判定不是我们的" —— 本轮干净完成也洗不掉那条外来错误(lastError 只写不清),
    // 调用方看到的就是一次成功请求配着别人的失败信息。
    const st2 = (await call3("agent_bridge_status", { session_id: sid }, 15000))?.session;
    ok("status 拿到了会话", !!st2, JSON.stringify(st2));
    ok("迟到事件的错误没有写进本轮的 lastError", st2?.lastError === null, JSON.stringify(st2?.lastError));
    ok("本轮干净完成 → health 仍是 healthy", st2?.health === "healthy", JSON.stringify(st2?.health));
    await call3("agent_bridge_close_session", {}, 15000);
  }
  try { srv3.stdin.end(); } catch {}
  await sleep(1200);
  try { srv3.kill("SIGKILL"); } catch {}
  try { fs.rmSync(STATE3, { recursive: true, force: true }); } catch {}
}

/** 一次请求内有多个子轮时,`turn_end` 不代表请求结束 —— 只有 `agent_end` 才是。
 *
 *  这是**上游协议的定义**,不是猜的(本机安装的 omp 16.0.3 源码):
 *   · `pi-agent-core/src/types.ts`  "Turn lifecycle - a turn is one assistant response + any tool calls/results"
 *   · `pi-agent-core/src/agent-loop.ts`  一次 prompt 会发出多组 turn_start→turn_end
 *   · `pi-coding-agent/src/session/agent-session.ts`  "Subscribers (rpc-mode, ACP, Cursor) treat
 *     agent_end as the 'session is idle' signal" —— 桥就是 rpc-mode 消费者
 *
 *  桥若把 turn_end 当请求结束,就会在第一个子轮(工具调用间隙)交出半句话。
 *  判别力:把桥改回"turn_end 即结束",这条必红成 `PARTIAL_`。 */
async function t6_tool_turns() {
  console.log("\n[T6] 一次请求内多个子轮:只有 agent_end 才算结束");
  const STATE4 = fs.mkdtempSync(path.join(os.tmpdir(), "ab-toolturns-"));
  const srv4 = spawn("node", [BRIDGE, "mcp"], {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    env: { ...process.env, AGENT_BRIDGE_STATE_DIR: STATE4, OMP_BIN: FAKE, FAKE_OMP_MODE: "toolturns" },
  });
  let gone = null;
  srv4.on("close", (code) => { gone = code; });
  srv4.stderr.on("data", d => process.stdout.write(`[srv4-stderr] ${d}`));
  const resp4 = new Map();
  let b4 = "";
  srv4.stdout.on("data", d => {
    b4 += d.toString();
    let i;
    while ((i = b4.indexOf("\n")) >= 0) {
      const line = b4.slice(0, i).trim(); b4 = b4.slice(i + 1);
      if (!line) continue;
      try { const m = JSON.parse(line); if (m && m.id !== undefined) resp4.set(m.id, m); } catch {}
    }
  });
  let id4 = 1;
  const wait4 = async (id, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (resp4.has(id)) return resp4.get(id); if (gone !== null) return null; await sleep(40); }
    return undefined;
  };
  const call4 = async (name, args, ms = 30000) => {
    const id = id4++;
    srv4.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
    return parse(await wait4(id, ms));
  };
  const ini = id4++;
  srv4.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: ini, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "repro-toolturns", version: "0" } } }) + "\n");
  await wait4(ini, 10000);
  srv4.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const sid = (await call4("agent_bridge_open_session", { agent: "omp", cwd: CWD }))?.session?.id;
  ok("会话开起来了", !!sid);
  if (sid) {
    await call4("agent_bridge_send_message", { session_id: sid, message: "go" }, 15000);
    const w = await call4("agent_bridge_wait", { session_ids: [sid], mode: "all", timeout_ms: 20000 }, 30000);
    const r = w?.results?.[0];
    ok("wait 返回了 results", !!r && !w?.timedOut, JSON.stringify(w).slice(0, 300));
    ok("没有在第一个子轮就交出半句话", r?.text !== "PARTIAL_", JSON.stringify(r?.text));
    ok("等到 agent_end 才收,拿到的是最终答案", r?.text === "TOOLTURNS_ANSWER", JSON.stringify(r?.text));
    ok("会话状态是 idle", r?.status === "idle", `status=${r?.status}`);
    await call4("agent_bridge_close_session", {}, 15000);
  }
  try { srv4.stdin.end(); } catch {}
  await sleep(1200);
  try { srv4.kill("SIGKILL"); } catch {}
  try { fs.rmSync(STATE4, { recursive: true, force: true }); } catch {}
}

async function main() {
  const initId = nextId++;
  rpc({ jsonrpc: "2.0", id: initId, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "repro-multiturn", version: "0" } } });
  if (!await waitResp(initId, 10000)) return bail("server never initialized");
  rpc({ jsonrpc: "2.0", method: "notifications/initialized" });

  console.log("\n[T1] wait 交出的「已结束」结果,自身状态不能是 running");
  const sid = (await call("agent_bridge_open_session", { agent: "omp", cwd: CWD }))?.session?.id;
  ok("会话开起来了", !!sid);
  if (!sid) return bail("open_session failed");

  ok("send 被接收", !!await call("agent_bridge_send_message", { session_id: sid, message: "go" }, 15000));

  const w = await call("agent_bridge_wait", { session_ids: [sid], mode: "all", timeout_ms: 20000 }, 30000);
  ok("wait 返回了", !!w, exited ? `服务退出 code=${exited.code}` : "没回话");
  const r = w?.results?.[0];
  ok("wait 给的是 results(不是 timedOut)", !!r && !w?.timedOut, JSON.stringify(w).slice(0, 300));
  // ★ 核心:桥说"结束了",它自己报的状态就必须真的是终态
  ok("「已结束」的结果状态是 idle,不是 running", r?.status === "idle", `status=${r?.status}`);
  // ★ 核心:拿到的是最终答案,不是第一段内部 turn 吐的那个 "."
  ok("拿到的是最终答案,不是半句", r?.text === "MULTITURN_ANSWER", JSON.stringify(r?.text));
  ok("charCount 与正文一致", r?.charCount === "MULTITURN_ANSWER".length, `charCount=${r?.charCount}`);

  console.log("\n[T2] 再查一次状态:陈旧写回不能把上一轮的正文救回来");
  const st = await call("agent_bridge_status", { session_id: sid }, 15000);
  ok("会话已回到 idle", st?.session?.status === "idle", `status=${st?.session?.status}`);
  const again = await call("agent_bridge_result", { session_id: sid }, 15000);
  ok("再取一次仍是最终答案(没被旧正文污染)", again?.text === "MULTITURN_ANSWER", JSON.stringify(again?.text));

  await call("agent_bridge_close_session", {}, 15000);
  await t3_within_one_rpc();
  await t5_late_terminal();
  await t6_tool_turns();

  console.log(`\n[harness] ${pass} 通过 / ${fail} 失败`);
  console.log(fail === 0 ? "[harness] >>> PASS" : "[harness] >>> FAIL");
  try { srv.stdin.end(); } catch {}
  setTimeout(() => { try { fs.rmSync(STATE, { recursive: true, force: true }); } catch {} process.exit(fail === 0 ? 0 : 1); }, 1500);
}

main().catch(e => bail(String(e)));
