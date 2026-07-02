// Repro/verify for T7 (A3): session aliases (name). A name can be used anywhere a session_id is
// accepted (send/status/wait/result/abort/close), is echoed in status, must be unique, and must not
// collide with an existing session id (else getSession's id-first resolution would shadow it).
// Drives the real MCP server with fake-omp `okturn`. Zero real model usage.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(HERE, "../../scripts/agent-bridge.mjs");
const CWD = path.resolve(HERE, "../..");
const FAKE = path.join(HERE, process.platform === "win32" ? "fake-omp.cmd" : "fake-omp.sh");

const sleep = ms => new Promise(r => setTimeout(r, ms));
const srv = spawn("node", [BRIDGE, "mcp"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, OMP_BIN: FAKE, FAKE_OMP_MODE: "okturn" } });
console.log(`[harness] server pid=${srv.pid}`);
let exited = null;
srv.on("close", (code, signal) => { exited = { code, signal }; console.log(`[srv-close] code=${code} signal=${signal}`); });
srv.stderr.on("data", d => process.stdout.write(`[srv-stderr] ${d}`));
const responses = new Map();
let buf = "";
srv.stdout.on("data", d => { buf += d.toString(); let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; try { const m = JSON.parse(line); if (m.id !== undefined) responses.set(m.id, m); } catch {} } });
const rpc = o => srv.stdin.write(JSON.stringify(o) + "\n");
let nextId = 1;
async function waitResp(id, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (responses.has(id)) return responses.get(id); if (exited) return null; await sleep(30); } return undefined; }
const parse = resp => { const t = resp?.result?.content?.[0]?.text; return t ? JSON.parse(t) : null; };
function fail(msg) { console.log(`[harness] >>> FAIL: ${msg}`); try { srv.kill("SIGKILL"); } catch {} process.exit(1); }
async function callRaw(name, args, timeoutMs) { const id = nextId++; rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }); const r = await waitResp(id, timeoutMs); if (r === undefined) return fail(`${name} no response`); if (r === null) return fail(`server exited during ${name}`); return r; }
const call = async (n, a, ms) => parse(await callRaw(n, a, ms));
const errText = r => r?.error?.message || (r?.result?.isError ? (r.result.content?.[0]?.text || "") : "");

async function main() {
  const initId = nextId++;
  rpc({ jsonrpc: "2.0", id: initId, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "repro-name", version: "0" } } });
  if (!await waitResp(initId, 10000)) return fail("server never initialized");
  rpc({ jsonrpc: "2.0", method: "notifications/initialized" });

  // 1. open with a name → echoed
  const o1 = await call("agent_bridge_open_session", { agent: "omp", cwd: CWD, name: "dev" }, 30000);
  const sid = o1?.session?.id;
  if (!sid) return fail("open with name failed");
  if (o1.session.name !== "dev") return fail(`open should echo name "dev", got ${JSON.stringify(o1.session.name)}`);
  console.log(`[harness] opened ${sid} name=dev`);

  // 2. status BY NAME → resolves to the same session, echoes name
  const st = await call("agent_bridge_status", { session_id: "dev" }, 10000);
  if (st?.session?.id !== sid) return fail(`status by name should resolve to ${sid}, got ${st?.session?.id}`);
  if (st?.session?.name !== "dev") return fail(`status by name should echo name, got ${JSON.stringify(st?.session?.name)}`);
  console.log(`[harness] status by name → ${st.session.id}`);

  // 3. send + wait BY NAME → clean turn
  await call("agent_bridge_send_message", { session_id: "dev", message: "go" }, 10000);
  const w = await call("agent_bridge_wait", { session_ids: ["dev"], mode: "all", timeout_ms: 8000 }, 12000);
  const r0 = w?.results?.[0];
  if (r0?.sessionId !== sid) return fail(`wait by name should return canonical id ${sid}, got ${r0?.sessionId}`);
  if (!(r0?.text || "").includes("OKTURN_ANSWER")) return fail(`wait by name missing answer, got ${JSON.stringify(r0?.text)}`);
  console.log(`[harness] send+wait by name OK (canonical id ${r0.sessionId})`);

  // 4. duplicate name rejected
  const dup = await callRaw("agent_bridge_open_session", { agent: "omp", cwd: CWD, name: "dev" }, 30000);
  if (!/already in use/i.test(errText(dup))) return fail(`duplicate name should be rejected, got ${JSON.stringify(parse(dup))}`);
  console.log(`[harness] duplicate name rejected: ${errText(dup).slice(0, 60)}`);

  // 5. name equal to an existing session id rejected (would be shadowed by id-first resolution)
  const clash = await callRaw("agent_bridge_open_session", { agent: "omp", cwd: CWD, name: sid }, 30000);
  if (!/collides with an existing session id/i.test(errText(clash))) return fail(`name==existing id should be rejected, got ${JSON.stringify(parse(clash))}`);
  console.log(`[harness] name==id rejected: ${errText(clash).slice(0, 60)}`);

  // 6. unknown name errors
  const unk = await callRaw("agent_bridge_status", { session_id: "no-such-name" }, 10000);
  if (!/Unknown session/i.test(errText(unk))) return fail(`unknown name should error, got ${JSON.stringify(parse(unk))}`);
  console.log(`[harness] unknown name errors cleanly`);

  console.log("[harness] >>> PASS: session name — echoed, addressable (send/status/wait), unique, no id collision, unknown rejected");
  await call("agent_bridge_close_session", {}, 10000);
  try { srv.stdin.end(); } catch {}
  setTimeout(() => process.exit(0), 1500);
}
main().catch(e => fail(String(e)));
