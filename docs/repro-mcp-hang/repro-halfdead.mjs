// Repro/verify for the half-dead OMP backend fast-fail (v0.8.3): a backend whose process is alive and
// whose stdin still accepts writes, but which never answers, must be declared FAILED after
// AGENT_BRIDGE_OMP_RPC_TIMEOUT_FAILS consecutive RPC timeouts — so wait returns a failure promptly
// instead of polling 10s timeouts until the caller's (here 60s) deadline. Uses fake-omp silent mode.
// PASS = wait returns status "failed" well before the 60s deadline; FAIL = it hangs to the watch limit.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(HERE, "../../scripts/agent-bridge.mjs");
const CWD = path.resolve(HERE, "../..");
const FAKE = path.join(HERE, process.platform === "win32" ? "fake-omp.cmd" : "fake-omp.sh");

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Tight knobs so the test is quick: 1.2s per RPC, fail after 2 consecutive timeouts (~3s to FAILED).
const srv = spawn("node", [BRIDGE, "mcp"], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  env: { ...process.env, OMP_BIN: FAKE, FAKE_OMP_MODE: "silent", AGENT_BRIDGE_OMP_RPC_TIMEOUT_MS: "1200", AGENT_BRIDGE_OMP_RPC_TIMEOUT_FAILS: "2" },
});
console.log(`[harness] server pid=${srv.pid} (FAKE_OMP_MODE=silent, rpc_timeout=1200ms, fails=2)`);

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
  rpc({ jsonrpc: "2.0", id: initId, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "repro-halfdead", version: "0" } } });
  if (!await waitResp(initId, 10000)) return fail("server never initialized");
  rpc({ jsonrpc: "2.0", method: "notifications/initialized" });

  const openId = nextId++;
  rpc({ jsonrpc: "2.0", id: openId, method: "tools/call", params: { name: "agent_bridge_open_session", arguments: { agent: "omp", cwd: CWD } } });
  const sid = parse(await waitResp(openId, 30000))?.session?.id;
  if (!sid) return fail("open_session failed");
  console.log(`[harness] opened ${sid}; backend will go silent on get_state`);

  const sendId = nextId++;
  rpc({ jsonrpc: "2.0", id: sendId, method: "tools/call", params: { name: "agent_bridge_send_message", arguments: { session_id: sid, message: "go" } } });
  if (!await waitResp(sendId, 10000)) return fail("send did not ack");

  // LONG wait deadline. If the fast-fail works, the session is declared failed in ~3s and wait returns
  // well before this; if it is broken, wait would only return at the 60s deadline (timedOut).
  const t0 = Date.now();
  const waitId = nextId++;
  rpc({ jsonrpc: "2.0", id: waitId, method: "tools/call", params: { name: "agent_bridge_wait", arguments: { session_ids: [sid], mode: "all", timeout_ms: 60000 } } });

  const resp = await waitResp(waitId, 20000); // watch window << 60s deadline
  const elapsed = Date.now() - t0;
  if (resp === undefined) return fail(`wait did NOT return within 20s (elapsed ${elapsed}ms) — half-dead backend not fast-failed`);
  if (resp === null) return fail(`server exited unexpectedly: ${JSON.stringify(exited)}`);
  const out = parse(resp);
  const st = out?.results?.[0]?.status ?? out?.completed?.status;
  console.log(`[harness] wait returned in ${elapsed}ms; session status=${st}; timedOut=${out?.timedOut ?? false}`);
  if (out?.timedOut) return fail(`wait timedOut instead of fast-failing (elapsed ${elapsed}ms)`);
  if (st !== "failed") return fail(`expected status "failed", got "${st}"`);
  if (elapsed > 15000) return fail(`fast-fail too slow: ${elapsed}ms`);

  console.log(`[harness] >>> PASS: half-dead backend declared failed in ${elapsed}ms (<< 60s wait deadline)`);
  const closeId = nextId++;
  rpc({ jsonrpc: "2.0", id: closeId, method: "tools/call", params: { name: "agent_bridge_close_session", arguments: { session_id: sid } } });
  await waitResp(closeId, 5000);
  try { srv.stdin.end(); } catch {}
  setTimeout(() => process.exit(0), 1500);
}

main().catch(e => fail(String(e)));
