// Repro/verify for T3 (P2): OMP send() must reject a concurrent turn, like Codex ("already has a
// running turn") and Claude do. Pre-fix OmpRpcSession.send() had no turn-in-flight guard, so a second
// send() during a running turn would issue another `prompt` RPC and interleave it into the same
// context — silent corruption instead of a clear error.
//
// Drives the real MCP server with fake-omp in FAKE_OMP_MODE=slowturn (a turn that stays running ~2.5s).
// Sequence: non-blocking send #1 (turn now in flight) -> send #2 mid-turn (must ERROR) -> abort ->
// send #3 (must succeed: the guard cleared). Zero real model usage.
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
  env: { ...process.env, OMP_BIN: FAKE, FAKE_OMP_MODE: "slowturn" },
});
console.log(`[harness] server pid=${srv.pid} (FAKE_OMP_MODE=slowturn)`);

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
async function waitResp(id, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (responses.has(id)) return responses.get(id); if (exited) return null; await sleep(30); } return undefined; }
const parse = resp => { const t = resp?.result?.content?.[0]?.text; return t ? JSON.parse(t) : null; };

function fail(msg) { console.log(`[harness] >>> FAIL: ${msg}`); try { srv.kill("SIGKILL"); } catch {} process.exit(1); }

async function callRaw(name, args, timeoutMs) {
  const id = nextId++;
  rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const resp = await waitResp(id, timeoutMs);
  if (resp === undefined) return fail(`${name} got no response in ${timeoutMs}ms`);
  if (resp === null) return fail(`server exited during ${name}`);
  return resp;
}
const call = async (name, args, timeoutMs) => parse(await callRaw(name, args, timeoutMs));
// Extract an error string whether it came back as a JSON-RPC error or an isError tool result.
const errText = resp => resp?.error?.message || (resp?.result?.isError ? (resp.result.content?.[0]?.text || "") : "");

async function main() {
  const initId = nextId++;
  rpc({ jsonrpc: "2.0", id: initId, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "repro-omp-concurrent", version: "0" } } });
  if (!await waitResp(initId, 10000)) return fail("server never initialized");
  rpc({ jsonrpc: "2.0", method: "notifications/initialized" });

  const sid = (await call("agent_bridge_open_session", { agent: "omp", cwd: CWD }, 30000))?.session?.id;
  if (!sid) return fail("open_session failed");
  console.log(`[harness] opened ${sid}`);

  // send #1: non-blocking (wait defaults false) -> returns an ack while the ~2.5s turn runs.
  const s1 = await call("agent_bridge_send_message", { session_id: sid, message: "first" }, 10000);
  if (!(s1?.accepted || s1?.status === "running")) return fail(`send #1 should be accepted/running, got ${JSON.stringify(s1)}`);
  console.log(`[harness] send #1 accepted, turn in flight`);

  // send #2: mid-turn -> MUST be rejected as concurrent.
  const s2raw = await callRaw("agent_bridge_send_message", { session_id: sid, message: "second" }, 10000);
  const s2err = errText(s2raw);
  if (!s2err) return fail(`send #2 during a running turn should have errored, got ${JSON.stringify(parse(s2raw))}`);
  if (!/already has a running turn/i.test(s2err)) return fail(`send #2 error should say "already has a running turn", got: ${s2err.slice(0, 120)}`);
  console.log(`[harness] send #2 correctly rejected: ${s2err.slice(0, 80)}`);

  // Recovery: abort clears turnInFlight -> a subsequent send is accepted again.
  await call("agent_bridge_abort", { session_id: sid }, 10000);
  const s3 = await call("agent_bridge_send_message", { session_id: sid, message: "third" }, 10000);
  if (!(s3?.accepted || s3?.status === "running")) return fail(`send #3 after abort should be accepted, got ${JSON.stringify(s3)}`);
  console.log(`[harness] send #3 accepted after abort (guard cleared)`);

  console.log("[harness] >>> PASS: OMP rejects a concurrent turn ('already has a running turn') and recovers after abort");
  await call("agent_bridge_abort", { session_id: sid }, 10000);
  await call("agent_bridge_close_session", {}, 10000);
  try { srv.stdin.end(); } catch {}
  setTimeout(() => process.exit(0), 1500);
}

main().catch(e => fail(String(e)));
