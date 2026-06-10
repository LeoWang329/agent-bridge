// Repro/verify for the wait() dead-wait on a session with no in-flight turn (v0.8.4 / turnInFlight,
// the root-cause completion of R2). A session whose prompt was REJECTED by the backend returns to
// idle with no turn streaming. Pre-fix the OMP settle gate was idle && (turnStarted || !everPrompted):
// a rejected prompt left turnStarted=false and everPrompted=true (latched), so sessionSettled was
// false forever and wait() dead-blocked until its full timeout. The fix replaces that proxy with a
// turnInFlight flag that is CLEARED in send()'s rejection catch, so the genuinely-idle session settles
// immediately. Reachable in the common "open N sessions, send to each, wait on all N opened ids"
// pattern: if one send errors, the consumer still tends to wait on that id.
//
// Drives the real MCP server with fake-omp in FAKE_OMP_MODE=rejectprompt (refuses every prompt,
// stays alive idle). Zero real model usage.
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
  env: { ...process.env, OMP_BIN: FAKE, FAKE_OMP_MODE: "rejectprompt" },
});
console.log(`[harness] server pid=${srv.pid} (FAKE_OMP_MODE=rejectprompt)`);

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

async function callRaw(name, args, timeoutMs) {
  const id = nextId++;
  rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const resp = await waitResp(id, timeoutMs);
  if (resp === undefined) return fail(`${name} got no response in ${timeoutMs}ms`);
  if (resp === null) return fail(`server exited during ${name}`);
  return resp; // raw JSON-RPC response (may carry an error / isError result)
}
const call = async (name, args, timeoutMs) => parse(await callRaw(name, args, timeoutMs));

async function main() {
  const initId = nextId++;
  rpc({ jsonrpc: "2.0", id: initId, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "repro-waitfail", version: "0" } } });
  if (!await waitResp(initId, 10000)) return fail("server never initialized");
  rpc({ jsonrpc: "2.0", method: "notifications/initialized" });

  const sid = (await call("agent_bridge_open_session", { agent: "omp", cwd: CWD }, 30000))?.session?.id;
  if (!sid) return fail("open_session failed");
  console.log(`[harness] opened ${sid}`);

  // Send a prompt the fake will REJECT. send() rejects -> the tool call returns an error/isError.
  // We don't care about the exact shape; what matters is the session is now idle with no turn.
  const sendResp = await callRaw("agent_bridge_send_message", { session_id: sid, message: "go" }, 10000);
  const sendErrored = Boolean(sendResp?.error) || Boolean(sendResp?.result?.isError);
  console.log(`[harness] send errored as expected: ${sendErrored}`);
  if (!sendErrored) return fail("send was expected to error (prompt rejected) but did not");

  // The crux: wait on the rejected session. With the fix it settles immediately (idle, turnInFlight
  // cleared in the catch); pre-fix it dead-waits the full timeout.
  const t0 = Date.now();
  const w = await call("agent_bridge_wait", { session_ids: [sid], mode: "any", timeout_ms: 6000 }, 10000);
  const elapsed = Date.now() - t0;
  console.log(`[harness] wait: timedOut=${w?.timedOut ?? false} completed=${w?.completed?.sessionId} status=${w?.completed?.status} in ${elapsed}ms`);
  if (w?.timedOut) return fail(`rejected-prompt session dead-waited (timedOut after ${elapsed}ms) — turnInFlight not cleared on rejection`);
  if (w?.completed?.sessionId !== sid) return fail(`wait did not surface the rejected session (${w?.completed?.sessionId})`);
  if (elapsed > 3000) return fail(`settled but took ${elapsed}ms — should be near-immediate`);

  console.log("[harness] >>> PASS: a rejected-prompt session settles wait() immediately (no dead-wait)");
  await call("agent_bridge_close_session", {}, 10000);
  try { srv.stdin.end(); } catch {}
  setTimeout(() => process.exit(0), 1500);
}

main().catch(e => fail(String(e)));
