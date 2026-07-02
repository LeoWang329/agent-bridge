// Repro/verify for T9 (A5): derived `health` triage (healthy | degraded | dead). Health is computed
// from CURRENT liveness + the LAST turn's outcome (lastTurnError), never from sticky lastError.
// Scenarios (each on its own fake-omp server, since FAKE_OMP_MODE is server-wide):
//   healthy  — okturn clean turn → health "healthy" (and a benign stderr line must NOT make it degraded).
//   dead     — kill the backend process → health "dead".
//   degraded — errturn (turn_end stopReason:error) → session idle but health "degraded" + lastError set.
// Also asserts wait().completed.health is carried through (deterministic proof of the T1 passthrough).
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(HERE, "../../scripts/agent-bridge.mjs");
const CWD = path.resolve(HERE, "../..");
const win = process.platform === "win32";
const FAKE = path.join(HERE, win ? "fake-omp.cmd" : "fake-omp.sh");
const FAKE_CLAUDE = path.join(HERE, win ? "fake-claude.cmd" : "fake-claude.sh");
const sleep = ms => new Promise(r => setTimeout(r, ms));

function fail(msg) { console.log(`[harness] >>> FAIL: ${msg}`); process.exit(1); }

// One MCP server bound to a given FAKE_OMP_MODE; returns a small client with call().
function makeServer(mode) {
  const srv = spawn("node", [BRIDGE, "mcp"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, OMP_BIN: FAKE, FAKE_OMP_MODE: mode, CLAUDE_BIN: FAKE_CLAUDE } });
  let exited = null;
  srv.on("close", (code, signal) => { exited = { code, signal }; });
  srv.stderr.on("data", d => process.stdout.write(`[srv-stderr:${mode}] ${d}`));
  const responses = new Map();
  let buf = "";
  srv.stdout.on("data", d => { buf += d.toString(); let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; try { const m = JSON.parse(line); if (m.id !== undefined) responses.set(m.id, m); } catch {} } });
  const rpc = o => srv.stdin.write(JSON.stringify(o) + "\n");
  let nextId = 1;
  const waitResp = async (id, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (responses.has(id)) return responses.get(id); if (exited) return null; await sleep(30); } return undefined; };
  const parse = resp => { const t = resp?.result?.content?.[0]?.text; return t ? JSON.parse(t) : null; };
  const call = async (name, args, ms = 15000) => { const id = nextId++; rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }); const r = await waitResp(id, ms); if (!r) return fail(`${name} no response (mode ${mode})`); return parse(r); };
  const init = async () => { const id = nextId++; rpc({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "repro-health", version: "0" } } }); if (!await waitResp(id, 10000)) return fail("no init"); rpc({ jsonrpc: "2.0", method: "notifications/initialized" }); };
  return { srv, call, init, kill: () => { try { srv.kill("SIGKILL"); } catch {} } };
}

async function main() {
  // --- healthy + dead (okturn) ---
  const s1 = makeServer("okturn");
  await s1.init();
  const oId = (await s1.call("agent_bridge_open_session", { agent: "omp", cwd: CWD }, 30000))?.session?.id;
  if (!oId) return fail("open omp (okturn) failed");
  await s1.call("agent_bridge_send_message", { session_id: oId, message: "go" });
  const w = await s1.call("agent_bridge_wait", { session_ids: [oId], mode: "all", timeout_ms: 8000 });
  const wc = w?.results?.[0];
  if (wc?.health !== "healthy") return fail(`wait().results[0].health should be "healthy" (T1 passthrough + T9), got ${JSON.stringify(wc?.health)}`);
  const stHealthy = (await s1.call("agent_bridge_status", { session_id: oId }))?.session;
  if (stHealthy?.health !== "healthy") return fail(`clean turn should be healthy, got ${JSON.stringify(stHealthy?.health)} (lastError=${JSON.stringify(stHealthy?.lastError)})`);
  if (stHealthy?.lastError !== null) return fail(`benign stderr must not set lastError (would falsely look degraded), got ${JSON.stringify(stHealthy?.lastError)}`);
  console.log(`[harness] healthy OK — status.health=healthy, wait.health=healthy, lastError=null (benign stderr in lastStderr)`);

  const pid = stHealthy?.pid;
  if (!pid) return fail("no backend pid to kill");
  try { process.kill(pid, "SIGKILL"); } catch (e) { return fail(`could not kill backend pid ${pid}: ${e.message}`); }
  let deadHealth = null;
  for (let i = 0; i < 25; i++) { await sleep(200); const s = (await s1.call("agent_bridge_status", { session_id: oId }))?.session; deadHealth = s?.health; if (deadHealth === "dead") break; }
  if (deadHealth !== "dead") return fail(`after killing the backend, health should be "dead", got ${JSON.stringify(deadHealth)}`);
  console.log(`[harness] dead OK — killed backend pid ${pid} → status.health=dead`);
  s1.kill();
  await sleep(300);

  // --- degraded (errturn) ---
  const s2 = makeServer("errturn");
  await s2.init();
  const eId = (await s2.call("agent_bridge_open_session", { agent: "omp", cwd: CWD }, 30000))?.session?.id;
  if (!eId) return fail("open omp (errturn) failed");
  await s2.call("agent_bridge_send_message", { session_id: eId, message: "go" });
  await s2.call("agent_bridge_wait", { session_ids: [eId], mode: "all", timeout_ms: 8000 });
  const stDeg = (await s2.call("agent_bridge_status", { session_id: eId }))?.session;
  if (stDeg?.health !== "degraded") return fail(`after a turn that ended in error, health should be "degraded", got ${JSON.stringify(stDeg?.health)} (status=${stDeg?.status})`);
  if (!/simulated turn error/i.test(stDeg?.lastError || "")) return fail(`errored turn should set lastError, got ${JSON.stringify(stDeg?.lastError)}`);
  console.log(`[harness] degraded OK — errored turn → status.health=degraded, lastError set, session still idle/reusable (status=${stDeg?.status})`);

  // abort must CLEAR the stale lastTurnError (abort is user-initiated, not a turn error) → back to healthy.
  await s2.call("agent_bridge_abort", { session_id: eId });
  const stAborted = (await s2.call("agent_bridge_status", { session_id: eId }))?.session;
  if (stAborted?.health !== "healthy") return fail(`after abort, health should return to "healthy" (stale lastTurnError cleared), got ${JSON.stringify(stAborted?.health)}`);
  console.log(`[harness] abort-clears-degraded OK — abort after an errored turn → status.health=healthy`);
  s2.kill();
  await sleep(300);

  // --- dead via SIGNAL on a backend WITHOUT an OMP-style `dead` flag (claude): exercises the
  // signalCode branch of procGone (exitCode stays null on signal death). ---
  const s3 = makeServer("okturn");
  await s3.init();
  const cId = (await s3.call("agent_bridge_open_session", { agent: "claude", cwd: CWD }, 30000))?.session?.id;
  if (!cId) return fail("open claude failed");
  const stCl = (await s3.call("agent_bridge_status", { session_id: cId }))?.session;
  if (stCl?.health !== "healthy") return fail(`fresh claude session should be healthy, got ${JSON.stringify(stCl?.health)}`);
  const cpid = stCl?.pid;
  if (!cpid) return fail("no claude backend pid");
  try { process.kill(cpid, "SIGKILL"); } catch (e) { return fail(`could not kill claude pid ${cpid}: ${e.message}`); }
  let clDead = null;
  for (let i = 0; i < 25; i++) { await sleep(200); const s = (await s3.call("agent_bridge_status", { session_id: cId }))?.session; clDead = s?.health; if (clDead === "dead") break; }
  if (clDead !== "dead") return fail(`SIGKILLed claude (no 'dead' flag, exitCode null + signalCode set) should be "dead", got ${JSON.stringify(clDead)}`);
  console.log(`[harness] dead-by-signal OK — SIGKILLed claude pid ${cpid} → status.health=dead (signalCode branch)`);
  s3.kill();

  console.log("[harness] >>> PASS: health = healthy | degraded | dead, derived from liveness + last-turn outcome (not sticky lastError); abort clears degraded; signal-death → dead");
  await sleep(300);
  process.exit(0);
}
main().catch(e => fail(String(e)));
