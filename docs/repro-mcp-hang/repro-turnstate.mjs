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

  // Non-blocking send; the fake then churns turn_start/turn_end on its own and settles on turn_end.
  const sendId = nextId++;
  rpc({ jsonrpc: "2.0", id: sendId, method: "tools/call", params: { name: "agent_bridge_send_message", arguments: { session_id: sid, message: "go" } } });
  if (!await waitResp(sendId, 10000)) return fail("send did not ack");

  await sleep(800); // let the turn churn settle (ends on turn_end; get_state still reports streaming)

  // Poll status. status(id) drives get_state -> state() flips status->running on the live isStreaming
  // reading; assert the clock never reports an end stamp while running.
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
