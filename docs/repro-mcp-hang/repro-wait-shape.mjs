// Repro/verify for T1 (N3): wait()'s summarize() must pass through EVERY top-level field that
// buildSessionResult produces (so later json/schemaError/health propagate automatically) WITHOUT
// leaking the two heavy fields `session` (full summary) and `recentEvents` (event stream), and
// WITHOUT changing the flat shape wait() has always returned.
//
// This locks the current wait() output key-set as a regression guard. The passthrough of a *new*
// field is proven deterministically by repro-health.mjs (T9), which asserts wait().completed.health
// is carried through — the first real top-level field added on top of this mechanism.
//
// Drives the real MCP server with fake-omp in FAKE_OMP_MODE=okturn (a clean, settling turn with
// answer text). Zero real model usage.
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
  env: { ...process.env, OMP_BIN: FAKE, FAKE_OMP_MODE: "okturn" },
});
console.log(`[harness] server pid=${srv.pid} (FAKE_OMP_MODE=okturn)`);

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

// The exact flat shape wait() has always returned for a settled session.
const EXPECTED = ["sessionId", "status", "text", "charCount", "byteCount", "truncated", "textRef", "lastTurn"];
// Heavy fields that must NEVER appear at the top level of a wait result (context hygiene).
const FORBIDDEN = ["session", "recentEvents"];

// Subset check on purpose (not exact key-count): later tasks intentionally ADD top-level fields
// (T9 health, T11 json/schemaError) that must pass through wait() — an exact-count assertion would
// wrongly break then. What this locks is: the historic keys are always present, and the two heavy
// fields never leak.
function assertShape(label, obj) {
  if (!obj || typeof obj !== "object") return fail(`${label}: not an object`);
  const keys = Object.keys(obj);
  for (const k of EXPECTED) if (!keys.includes(k)) return fail(`${label}: missing expected key '${k}' (got ${JSON.stringify(keys)})`);
  for (const k of FORBIDDEN) if (keys.includes(k)) return fail(`${label}: leaked heavy key '${k}' into wait output`);
  console.log(`[harness] ${label} OK — keys=${JSON.stringify(keys)}`);
}

async function main() {
  const initId = nextId++;
  rpc({ jsonrpc: "2.0", id: initId, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "repro-wait-shape", version: "0" } } });
  if (!await waitResp(initId, 10000)) return fail("server never initialized");
  rpc({ jsonrpc: "2.0", method: "notifications/initialized" });

  const sid = (await call("agent_bridge_open_session", { agent: "omp", cwd: CWD }, 30000))?.session?.id;
  if (!sid) return fail("open_session failed");
  console.log(`[harness] opened ${sid}`);

  await call("agent_bridge_send_message", { session_id: sid, message: "go" }, 10000);

  // wait(all): result lives in results[0]
  const wAll = await call("agent_bridge_wait", { session_ids: [sid], mode: "all", timeout_ms: 8000 }, 12000);
  if (wAll?.timedOut) return fail(`wait(all) timed out — okturn session did not settle`);
  const rAll = wAll?.results?.[0];
  assertShape("wait(all).results[0]", rAll);
  if (!(rAll?.text || "").includes("OKTURN_ANSWER")) return fail(`wait(all) missing answer text (got ${JSON.stringify(rAll?.text)})`);

  // Second turn so we can exercise wait(any).completed shape on the same settled session.
  await call("agent_bridge_send_message", { session_id: sid, message: "again" }, 10000);
  const wAny = await call("agent_bridge_wait", { session_ids: [sid], mode: "any", timeout_ms: 8000 }, 12000);
  if (wAny?.timedOut) return fail(`wait(any) timed out`);
  assertShape("wait(any).completed", wAny?.completed);

  console.log("[harness] >>> PASS: wait() output shape preserved; session/recentEvents not leaked; extra fields would pass through");
  await call("agent_bridge_close_session", {}, 10000);
  try { srv.stdin.end(); } catch {}
  setTimeout(() => process.exit(0), 1500);
}

main().catch(e => fail(String(e)));
