// Repro/verify for two wait() contract bugs (v0.8.4 / R1+R2):
//   R1 — mode:"any" with >=2 sessions settled in the SAME poll tick returned only settledIds[0] as
//        `completed` while excluding every other settled id from `pending` (it used pendingIds()).
//        The documented protocol is "pass `pending` back as the next call's session_ids; loop until
//        empty" — so a simultaneously-settled session's result was silently dropped from the loop.
//        Most common shape: send to A and B, do other work, call wait late — both already settled.
//   R2 — a NEVER-prompted OMP session could not satisfy sessionSettled (the turnStarted gate is
//        false until a first turn streams), so waiting on it dead-blocked until the full timeout,
//        while a fresh codex session settles immediately (`!turn`). Cross-backend inconsistency
//        whose failure mode is the expensive one (default 30-min dead wait).
// Drives the real MCP server with the fake-omp stub (FAKE_OMP_MODE=turnstate: a prompt acks, churns
// turn_start/turn_end on its own, and settles idle ~120ms later). Zero real model usage.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(HERE, "../../scripts/agent-bridge.mjs");
const CWD = path.resolve(HERE, "../..");
const FAKE = path.join(HERE, process.platform === "win32" ? "fake-omp.cmd" : "fake-omp.sh");

const sleep = ms => new Promise(r => setTimeout(r, ms));
const srv = spawn("node", [BRIDGE, "mcp"], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  env: { ...process.env, OMP_BIN: FAKE, FAKE_OMP_MODE: "turnstate" },
});
console.log(`[harness] server pid=${srv.pid} (FAKE_OMP_MODE=turnstate)`);

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
    try { const m = JSON.parse(line); if (m.id !== undefined) responses.set(m.id, m); } catch {}
  }
});
const rpc = o => srv.stdin.write(JSON.stringify(o) + "\n");
let nextId = 1;
async function waitResp(id, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (responses.has(id)) return responses.get(id); if (exited) return null; await sleep(40); } return undefined; }
const parse = resp => { const t = resp?.result?.content?.[0]?.text; return t ? JSON.parse(t) : null; };

function fail(msg) { console.log(`[harness] >>> FAIL: ${msg}`); try { srv.kill("SIGKILL"); } catch {} process.exit(1); }

async function call(name, args, timeoutMs) {
  const id = nextId++;
  rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const resp = await waitResp(id, timeoutMs);
  if (resp === undefined) return fail(`${name} got no response in ${timeoutMs}ms`);
  if (resp === null) return fail(`server exited during ${name}`);
  return parse(resp);
}

async function main() {
  const initId = nextId++;
  rpc({ jsonrpc: "2.0", id: initId, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "repro-waitany", version: "0" } } });
  if (!await waitResp(initId, 10000)) return fail("server never initialized");
  rpc({ jsonrpc: "2.0", method: "notifications/initialized" });

  // --- R1: two sessions, both settled BEFORE wait is called; mode:"any" must not drop the second.
  const a = (await call("agent_bridge_open_session", { agent: "omp", cwd: CWD }, 30000))?.session?.id;
  const b = (await call("agent_bridge_open_session", { agent: "omp", cwd: CWD }, 30000))?.session?.id;
  if (!a || !b) return fail("open_session failed for A/B");
  console.log(`[harness] R1 sessions: A=${a} B=${b}`);
  await call("agent_bridge_send_message", { session_id: a, message: "go" }, 10000);
  await call("agent_bridge_send_message", { session_id: b, message: "go" }, 10000);
  await sleep(1500); // fake settles each turn ~120ms after the prompt; both are idle+turnStarted now

  const w1 = await call("agent_bridge_wait", { session_ids: [a, b], mode: "any", timeout_ms: 8000 }, 12000);
  console.log(`[harness] R1 wait#1: timedOut=${w1?.timedOut ?? false} completed=${w1?.completed?.sessionId} pending=${JSON.stringify(w1?.pending)}`);
  if (w1?.timedOut) return fail("R1: wait(any) timed out with both sessions settled");
  const first = w1?.completed?.sessionId;
  if (first !== a && first !== b) return fail(`R1: completed is neither A nor B (${first})`);
  const other = first === a ? b : a;
  if (!Array.isArray(w1?.pending) || !w1.pending.includes(other)) {
    return fail(`R1: simultaneously-settled ${other} missing from pending — its result is dropped from the documented loop`);
  }
  const w2 = await call("agent_bridge_wait", { session_ids: w1.pending, mode: "any", timeout_ms: 8000 }, 12000);
  console.log(`[harness] R1 wait#2: timedOut=${w2?.timedOut ?? false} completed=${w2?.completed?.sessionId}`);
  if (w2?.completed?.sessionId !== other) return fail(`R1: second wait did not surface ${other}`);
  console.log("[harness] R1 OK: both settled sessions surfaced through the pending loop");

  // --- R2: a session that was never prompted must settle immediately (codex parity), not dead-wait.
  const c = (await call("agent_bridge_open_session", { agent: "omp", cwd: CWD }, 30000))?.session?.id;
  if (!c) return fail("open_session failed for C");
  const t0 = Date.now();
  const w3 = await call("agent_bridge_wait", { session_ids: [c], mode: "any", timeout_ms: 6000 }, 10000);
  const elapsed = Date.now() - t0;
  console.log(`[harness] R2 wait: timedOut=${w3?.timedOut ?? false} completed=${w3?.completed?.sessionId} in ${elapsed}ms`);
  if (w3?.timedOut || w3?.completed?.sessionId !== c) {
    return fail(`R2: wait on a never-prompted OMP session did not settle (timedOut=${w3?.timedOut ?? false}) — dead-waits until timeout`);
  }
  if (elapsed > 3000) return fail(`R2: settled but took ${elapsed}ms — should be immediate`);

  console.log("[harness] >>> PASS: wait(any) keeps simultaneously-settled ids in pending; never-prompted OMP session settles immediately");
  await call("agent_bridge_close_session", {}, 10000);
  try { srv.stdin.end(); } catch {}
  setTimeout(() => process.exit(0), 1500);
}

main().catch(e => fail(String(e)));
