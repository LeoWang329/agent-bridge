// Repro/verify for the parent-death watchdog (docs/INVESTIGATION-mcp-disconnect-2026-06-10.md):
// the server must self-exit when its spawning client dies *even if stdin never EOFs* (the hung-
// grandparent-holds-the-pipe shape that left zombies behind), and reap its backends on the way out.
//
// Isolation: this harness keeps the server's stdin OPEN the entire time (never .end()s it), so the
// stdin-EOF / P2 grace path cannot be what stops the server. The watchdog is pointed at a separate
// "victim" process via AGENT_BRIDGE_PARENT_PID; killing the victim is the only exit trigger.
// Uses the fake-omp stub (OMP_BIN) so there is a real backend to reap, with zero model usage.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(HERE, "../../scripts/agent-bridge.mjs");
const CWD = path.resolve(HERE, "../..");
const FAKE = path.join(HERE, process.platform === "win32" ? "fake-omp.cmd" : "fake-omp.sh");

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pidAlive = p => { try { process.kill(p, 0); return true; } catch (e) { return e.code !== "ESRCH"; } };

// 1) victim process the watchdog will watch (stand-in for the spawning client)
const victim = spawn(process.execPath, ["-e", "setInterval(()=>{}, 2147483647)"], { stdio: "ignore" });
console.log(`[harness] victim pid=${victim.pid}`);

// 2) the server, watchdog pointed at the victim, fast interval for the test
const srv = spawn("node", [BRIDGE, "mcp"], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  env: { ...process.env, OMP_BIN: FAKE, AGENT_BRIDGE_PARENT_PID: String(victim.pid), AGENT_BRIDGE_PARENT_WATCHDOG_MS: "1000" },
});
console.log(`[harness] server pid=${srv.pid} (watching victim ${victim.pid})`);

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

function fail(msg) { console.log(`[harness] >>> FAIL: ${msg}`); try { victim.kill("SIGKILL"); } catch {} try { srv.kill("SIGKILL"); } catch {} process.exit(1); }

async function main() {
  const initId = nextId++;
  rpc({ jsonrpc: "2.0", id: initId, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "repro-parent-death", version: "0" } } });
  if (!await waitResp(initId, 10000)) return fail("server never initialized");
  rpc({ jsonrpc: "2.0", method: "notifications/initialized" });

  const openId = nextId++;
  rpc({ jsonrpc: "2.0", id: openId, method: "tools/call", params: { name: "agent_bridge_open_session", arguments: { agent: "omp", cwd: CWD } } });
  const openResp = await waitResp(openId, 30000);
  const open = openResp?.result?.content?.[0]?.text ? JSON.parse(openResp.result.content[0].text) : null;
  const backendPid = open?.session?.pid;
  if (!backendPid) return fail(`open_session gave no backend pid: ${JSON.stringify(open)?.slice(0, 200)}`);
  console.log(`[harness] backend pid=${backendPid} alive=${pidAlive(backendPid)}`);

  // 3) kill the victim. stdin stays OPEN — only the watchdog can end the server now.
  console.log(`[harness] killing victim ${victim.pid}; stdin stays open (watchdog is the only exit path)`);
  victim.kill("SIGKILL");

  // 4) expect a clean self-exit within a few watchdog ticks
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline && !exited) await sleep(50);
  if (!exited) return fail("server did NOT self-exit after parent death (watchdog broken) — stdin still open");
  if (exited.code !== 0) return fail(`server exited but not cleanly: ${JSON.stringify(exited)}`);
  console.log(`[harness] server self-exited cleanly after parent death`);

  // 5) backend must be reaped by the clean shutdown
  await sleep(4000);
  if (pidAlive(backendPid)) return fail(`backend ${backendPid} still alive after server exit (not reaped)`);
  console.log(`[harness] backend ${backendPid} reaped`);

  console.log("[harness] >>> PASS: parent-death watchdog self-exits with stdin open and reaps backend");
  process.exit(0);
}

main().catch(e => fail(String(e)));
