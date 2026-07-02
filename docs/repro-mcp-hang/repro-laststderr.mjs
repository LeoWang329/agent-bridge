// Repro/verify for T4 (P1): benign backend STDERR must NOT masquerade as a fatal lastError.
// Pre-fix, every stderr chunk was written to session.lastError, which was never reset — so one benign
// progress line (e.g. codex's "failed to refresh available models") permanently polluted status.lastError.
// Fix routes stderr to a separate `lastStderr` (diagnostics); `lastError` stays null unless a real
// failure occurs.
//
// Covers OMP (fake-omp `okturn` writes a benign stderr line mid-turn) and Claude (fake-claude with
// FAKE_CLAUDE_STDERR writes one on startup). Codex's real-backend stderr ("failed to refresh available
// models") is asserted separately in e2e-real.mjs. Zero real model usage here.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(HERE, "../../scripts/agent-bridge.mjs");
const CWD = path.resolve(HERE, "../..");
const win = process.platform === "win32";
const FAKE_OMP = path.join(HERE, win ? "fake-omp.cmd" : "fake-omp.sh");
const FAKE_CLAUDE = path.join(HERE, win ? "fake-claude.cmd" : "fake-claude.sh");

const sleep = ms => new Promise(r => setTimeout(r, ms));
const srv = spawn("node", [BRIDGE, "mcp"], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  env: { ...process.env, OMP_BIN: FAKE_OMP, FAKE_OMP_MODE: "okturn", CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_STDERR: "1" },
});
console.log(`[harness] server pid=${srv.pid}`);
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
  rpc({ jsonrpc: "2.0", id: initId, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "repro-laststderr", version: "0" } } });
  if (!await waitResp(initId, 10000)) return fail("server never initialized");
  rpc({ jsonrpc: "2.0", method: "notifications/initialized" });

  // --- OMP: a clean turn that also writes a benign stderr line mid-turn ---
  const ompId = (await call("agent_bridge_open_session", { agent: "omp", cwd: CWD }, 30000))?.session?.id;
  if (!ompId) return fail("open omp failed");
  await call("agent_bridge_send_message", { session_id: ompId, message: "go" }, 10000);
  await call("agent_bridge_wait", { session_ids: [ompId], mode: "all", timeout_ms: 8000 }, 12000);
  const ompS = (await call("agent_bridge_status", { session_id: ompId }, 10000))?.session;
  console.log(`[harness] omp lastError=${JSON.stringify(ompS?.lastError)} lastStderr=${JSON.stringify((ompS?.lastStderr || "").trim())}`);
  if (ompS?.lastError !== null) return fail(`omp lastError should be null after a clean turn (benign stderr must not set it), got ${JSON.stringify(ompS?.lastError)}`);
  if (!/progress/i.test(ompS?.lastStderr || "")) return fail(`omp lastStderr should carry the benign stderr line, got ${JSON.stringify(ompS?.lastStderr)}`);
  console.log(`[harness] OMP OK — stderr routed to lastStderr, lastError clean`);

  // --- Claude: benign stderr on startup; no turn needed (session is idle on spawn) ---
  const clId = (await call("agent_bridge_open_session", { agent: "claude", cwd: CWD }, 30000))?.session?.id;
  if (!clId) return fail("open claude failed");
  await sleep(300); // let the startup stderr line be read
  const clS = (await call("agent_bridge_status", { session_id: clId }, 10000))?.session;
  console.log(`[harness] claude lastError=${JSON.stringify(clS?.lastError)} lastStderr=${JSON.stringify((clS?.lastStderr || "").trim())}`);
  if (clS?.lastError !== null) return fail(`claude lastError should be null (benign startup stderr must not set it), got ${JSON.stringify(clS?.lastError)}`);
  if (!/benign progress/i.test(clS?.lastStderr || "")) return fail(`claude lastStderr should carry the benign stderr line, got ${JSON.stringify(clS?.lastStderr)}`);
  console.log(`[harness] CLAUDE OK — stderr routed to lastStderr, lastError clean`);

  console.log("[harness] >>> PASS: benign stderr routes to lastStderr; lastError stays clean (no sticky pollution)");
  await call("agent_bridge_close_session", {}, 10000);
  try { srv.stdin.end(); } catch {}
  setTimeout(() => process.exit(0), 1500);
}

main().catch(e => fail(String(e)));
