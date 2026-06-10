// Repro variant: the backend breaks its stdin pipe while STAYING ALIVE (graceful-teardown
// shape), via the fake-omp stub injected through OMP_BIN. Before the P1 fix the wait hangs;
// after it the wait must fail fast. No real omp/model usage.
// Note (Windows): the .cmd shim means cmd.exe also holds a pipe handle, so the break is
// partial there — the hang still reproduces, which is the point.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(HERE, "../../scripts/agent-bridge.mjs");
const CWD = path.resolve(HERE, "../..");
const FAKE = path.join(HERE, process.platform === "win32" ? "fake-omp.cmd" : "fake-omp.sh");

const srv = spawn("node", [BRIDGE, "mcp"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, OMP_BIN: FAKE } });
console.log(`[harness] server pid=${srv.pid} (OMP_BIN=${FAKE})`);

let stderrBuf = "";
srv.stderr.on("data", d => { stderrBuf += d.toString(); process.stdout.write(`[srv-stderr] ${d.toString()}`); });
let exited = null;
srv.on("close", (code, signal) => { exited = { code, signal }; console.log(`[srv-close] code=${code} signal=${signal}`); });

const responses = new Map();
let lineBuf = "";
srv.stdout.on("data", d => {
  lineBuf += d.toString();
  let i;
  while ((i = lineBuf.indexOf("\n")) >= 0) {
    const line = lineBuf.slice(0, i).trim();
    lineBuf = lineBuf.slice(i + 1);
    if (!line) continue;
    try { const m = JSON.parse(line); if (m.id !== undefined) responses.set(m.id, m); } catch {}
  }
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rpc = obj => srv.stdin.write(JSON.stringify(obj) + "\n");
let nextId = 1;

async function main() {
  const initId = nextId++;
  rpc({ jsonrpc: "2.0", id: initId, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "repro-pipebreak", version: "0" } } });
  while (!responses.has(initId)) { if (exited) return bad("died during init"); await sleep(50); }
  rpc({ jsonrpc: "2.0", method: "notifications/initialized" });

  const openId = nextId++;
  rpc({ jsonrpc: "2.0", id: openId, method: "tools/call", params: { name: "agent_bridge_open_session", arguments: { agent: "omp", cwd: CWD } } });
  while (!responses.has(openId)) { if (exited) return bad("died during open"); await sleep(50); }
  const text = responses.get(openId)?.result?.content?.[0]?.text;
  const sid = (text ? JSON.parse(text) : null)?.session?.id;
  if (!sid) return bad(`open failed: ${String(text).slice(0, 300)}`);
  console.log(`[harness] opened ${sid}; fake backend breaks the pipe at T+3s of its life`);

  // Short wait timeout on purpose: post-fix the wait must come back no later than the wait
  // deadline + one OMP_RPC_TIMEOUT_MS (the in-flight poll has to time out first) — well inside
  // the 25s watch window. Pre-fix the loop is wedged inside `await state()` and never returns.
  const waitId = nextId++;
  rpc({ jsonrpc: "2.0", id: waitId, method: "tools/call", params: { name: "agent_bridge_wait", arguments: { session_ids: [sid], timeout_ms: 8000 } } });

  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (exited) return bad(`SERVER EXITED: ${JSON.stringify(exited)}\n${stderrBuf}`);
    if (responses.has(waitId)) {
      console.log(`[harness] wait returned in time — OK: ${String(responses.get(waitId)?.result?.content?.[0]?.text).slice(0, 240)}`);
      try { srv.stdin.end(); } catch {}
      setTimeout(() => process.exit(0), 2000);
      return;
    }
    await sleep(50);
  }
  console.log("[harness] >>> wait HUNG for 25s — BUG PRESENT");
  try { srv.stdin.end(); } catch {}
  setTimeout(() => { try { srv.kill("SIGKILL"); } catch {} process.exit(1); }, 2000);
}

function bad(msg) { console.log(`[harness] >>> ${msg}`); process.exit(1); }

main().catch(e => { console.error("[harness] error:", e); process.exit(1); });
