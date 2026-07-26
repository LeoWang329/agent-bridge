// Repro/verify for the OMP turn-clock incoherence (docs/BUG-omp-turn-state-inconsistency-2026-06-10.md,
// fixed in v0.8.3): a backend that churns turns on its own leaves turnEndedAt set while the session
// reads "running" — most importantly via status()/state(), which flips status->running on a live
// isStreaming reading WITHOUT clearing the stamp (the "second path" F8 guards). The bridge must NEVER
// report lastTurn.endedAt while status is "running". Uses the fake-omp stub in FAKE_OMP_MODE=turnstate
// (zero real model usage). PASS = no "running + endedAt" sample observed; FAIL = the contradiction.
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

async function main() {
  const initId = nextId++;
  rpc({ jsonrpc: "2.0", id: initId, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "repro-turnstate", version: "0" } } });
  if (!await waitResp(initId, 10000)) return fail("server never initialized");
  rpc({ jsonrpc: "2.0", method: "notifications/initialized" });

  const openId = nextId++;
  rpc({ jsonrpc: "2.0", id: openId, method: "tools/call", params: { name: "agent_bridge_open_session", arguments: { agent: "omp", cwd: CWD } } });
  const sid = parse(await waitResp(openId, 30000))?.session?.id;
  if (!sid) return fail("open_session failed");
  console.log(`[harness] opened ${sid}`);

  // ── Phase 1: a request that genuinely COMPLETES (agent_end), so the clock is really written. ──
  // Without this the whole test is vacuous: if turnEndedAt is never set, "endedAt must be null while
  // running" holds trivially and deleting F8's gate would not fail anything. (That is exactly what
  // happened when this fixture stopped emitting agent_end — the assertion below stayed green while
  // testing nothing.)
  const sendId = nextId++;
  rpc({ jsonrpc: "2.0", id: sendId, method: "tools/call", params: { name: "agent_bridge_send_message", arguments: { session_id: sid, message: "go" } } });
  if (!await waitResp(sendId, 10000)) return fail("send did not ack");

  const waitId = nextId++;
  rpc({ jsonrpc: "2.0", id: waitId, method: "tools/call", params: { name: "agent_bridge_wait", arguments: { session_ids: [sid], mode: "all", timeout_ms: 15000 } } });
  const done = parse(await waitResp(waitId, 25000));
  const finished = done?.results?.[0];
  if (!finished || done?.timedOut) return fail(`request did not complete: ${JSON.stringify(done).slice(0, 300)}`);
  if (finished.text !== "TURNSTATE_ANSWER") return fail(`expected the completed answer, got ${JSON.stringify(finished.text)}`);
  if (!finished.lastTurn?.endedAt) return fail(`a COMPLETED request must carry an end stamp — got ${JSON.stringify(finished.lastTurn)} (the clock is not being written, so the check below would be vacuous)`);
  if (!(finished.lastTurn.durationMs >= 0)) return fail(`completed request should report durationMs >= 0, got ${JSON.stringify(finished.lastTurn)}`);
  console.log(`[harness] phase 1 OK — completed request has endedAt=${finished.lastTurn.endedAt} durationMs=${finished.lastTurn.durationMs}`);

  // ── Phase 2: no further EVENTS — the fake now merely reports isStreaming:true to get_state. ──
  // status(id) drives get_state -> state() flips status->running while the end stamp from phase 1 is
  // still set internally. That "running + endedAt" contradiction is what F8's status-aware lastTurnOf
  // must suppress. Remove that gate and this goes red, because turnEndedAt IS non-null here.
  await sleep(600);
  let sawRunning = false;
  for (let k = 0; k < 6; k++) {
    const stId = nextId++;
    rpc({ jsonrpc: "2.0", id: stId, method: "tools/call", params: { name: "agent_bridge_status", arguments: { session_id: sid } } });
    const snap = parse(await waitResp(stId, 8000));
    const s = snap?.session;
    if (!s) return fail("status returned no session");
    const lt = s.lastTurn;
    console.log(`[harness] sample ${k}: status=${s.status} lastTurn.endedAt=${lt?.endedAt ?? null} durationMs=${lt?.durationMs ?? null}`);
    if (s.status === "running") {
      sawRunning = true;
      if (lt && lt.endedAt) return fail(`INCOHERENT: status=running but lastTurn.endedAt=${lt.endedAt} (durationMs=${lt.durationMs}) — F8 regression`);
    }
    await sleep(300);
  }
  if (!sawRunning) return fail("never observed status=running — test did not exercise the running case");

  console.log("[harness] >>> PASS: lastTurn never reports endedAt while running (coherent turn clock)");
  const closeId = nextId++;
  rpc({ jsonrpc: "2.0", id: closeId, method: "tools/call", params: { name: "agent_bridge_close_session", arguments: { session_id: sid } } });
  await waitResp(closeId, 5000);
  try { srv.stdin.end(); } catch {}
  setTimeout(() => process.exit(0), 1500);
}

main().catch(e => fail(String(e)));
