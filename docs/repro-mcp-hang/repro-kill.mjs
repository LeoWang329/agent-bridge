// Repro for the hang bug (docs/INVESTIGATION-mcp-disconnect-2026-06-10.md):
// kill an omp backend mid-`agent_bridge_wait` -> before the P1 fix the wait call
// hangs forever; after the fix it must return a failed session within ~1-2s.
// Drives a REAL `agent-bridge.mjs mcp` over stdio — no MCP client needed.
// Requires a real `omp` on PATH (no prompt is ever sent, so no model usage).
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(HERE, "../../scripts/agent-bridge.mjs");
const CWD = path.resolve(HERE, "../..");
const ATTEMPTS = 3;

const srv = spawn("node", [BRIDGE, "mcp"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
console.log(`[harness] server pid=${srv.pid}`);

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
const toolResult = resp => { const t = resp?.result?.content?.[0]?.text; return t ? JSON.parse(t) : null; };
let nextId = 1;

async function waitResponse(id, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (responses.has(id)) return responses.get(id);
    if (exited) return null;
    await sleep(50);
  }
  return undefined; // timed out
}

async function main() {
  const initId = nextId++;
  rpc({ jsonrpc: "2.0", id: initId, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "repro-kill", version: "0" } } });
  await waitResponse(initId, 10000);
  rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
  console.log("[harness] initialized");

  let hangs = 0;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    console.log(`\n[harness] ===== attempt ${attempt} =====`);
    const openId = nextId++;
    rpc({ jsonrpc: "2.0", id: openId, method: "tools/call", params: { name: "agent_bridge_open_session", arguments: { agent: "omp", cwd: CWD } } });
    const open = toolResult(await waitResponse(openId, 30000));
    const sid = open?.session?.id, backendPid = open?.session?.pid;
    console.log(`[harness] opened ${sid} backendPid=${backendPid}`);
    if (!sid || !backendPid) { console.log("[harness] open failed:", JSON.stringify(open)?.slice(0, 400)); break; }

    const waitId = nextId++;
    rpc({ jsonrpc: "2.0", id: waitId, method: "tools/call", params: { name: "agent_bridge_wait", arguments: { session_ids: [sid], timeout_ms: 60000 } } });
    await sleep(1200);
    try { process.kill(backendPid, "SIGKILL"); console.log(`[harness] SIGKILLed backend ${backendPid}`); } catch (e) { console.log(`[harness] kill failed: ${e.message}`); }

    const resp = await waitResponse(waitId, 10000);
    if (exited) { console.log(`[harness] >>> SERVER EXITED (bug variant): ${JSON.stringify(exited)}\n${stderrBuf}`); process.exit(1); }
    if (resp === undefined) { hangs++; console.log("[harness] >>> wait HUNG for 10s after backend death — BUG PRESENT"); }
    else console.log(`[harness] wait returned in time — OK: ${String(resp?.result?.content?.[0]?.text).slice(0, 240)}`);
  }

  console.log(`\n[harness] verdict: ${hangs}/${ATTEMPTS} attempts hung ${hangs ? "— BUG PRESENT" : "— bug not reproduced (fixed?)"}`);
  console.log("[harness] closing stdin; with the P2 fix the server must exit within ~5s even if requests are stuck.");
  try { srv.stdin.end(); } catch {}
  setTimeout(() => {
    console.log(`[harness] server ${exited ? `exited ${JSON.stringify(exited)} — P2 OK` : "STILL RUNNING after 8s — P2 BUG PRESENT (zombie)"}`);
    if (!exited) try { srv.kill("SIGKILL"); } catch {}
    process.exit(hangs ? 1 : 0);
  }, 8000);
}

main().catch(e => { console.error("[harness] error:", e); process.exit(1); });
