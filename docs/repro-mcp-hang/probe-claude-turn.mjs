// Send two turns to a real claude session and verify results. SKIPs if `claude` is not on PATH.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const BRIDGE = path.resolve(HERE, "../../scripts/agent-bridge.mjs");

if (spawnSync("claude", ["--version"], { encoding: "utf8" }).status !== 0) {
  console.log(">>> SKIP: claude not on PATH"); process.exit(0);
}
const { spawn } = await import("node:child_process");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const srv = spawn("node", [BRIDGE, "mcp"], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
let exited = null; srv.on("close", (code, signal) => { exited = { code, signal }; });
let buf = ""; const got = new Map();
srv.stdout.on("data", d => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) { try { const o = JSON.parse(l); if (o.id !== undefined) got.set(o.id, o); } catch {} } } });
srv.stderr.on("data", () => {});
let idc = 0;
function rpc(method, params) { const id = ++idc; srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); return id; }
async function call(name, args, waitMs = 60000) { const id = rpc("tools/call", { name, arguments: args }); const t = Date.now(); while (Date.now() - t < waitMs) { if (got.has(id)) break; await sleep(100); } const o = got.get(id); if (!o) throw new Error(`timeout ${name}`); if (o.error) return { __error: o.error }; try { return JSON.parse(o.result.content[0].text); } catch { return { __raw: o.result?.content?.[0]?.text }; } }

let pass = 0, fail = 0;
const check = (label, ok, extra = "") => { console.log(`[${ok ? "PASS" : "FAIL"}] ${label}${extra ? " — " + extra : ""}`); ok ? pass++ : fail++; };
try {
  rpc("initialize", { protocolVersion: "2025-06-18" }); await sleep(300);
  const o = await call("agent_bridge_open_session", { agent: "claude", cwd: REPO, write: false });
  const id = o.session?.id;
  check("open", !!id, id);
  // Turn 1 inline (wait:true)
  const r1 = await call("agent_bridge_send_message", { session_id: id, message: "Reply with exactly this token and nothing else: CLAUDE_T1", wait: true, timeout_ms: 120000 }, 140000);
  check("turn 1 result text", (r1.text || "").includes("CLAUDE_T1"), (r1.text || "").slice(0, 50));
  check("turn 1 settled to idle", r1.session?.status === "idle", r1.session?.status);
  check("turn 1 charCount reported", typeof r1.charCount === "number" && r1.charCount > 0, String(r1.charCount));
  // Turn 2 reuse (non-blocking then wait)
  await call("agent_bridge_send_message", { session_id: id, message: "Reply with exactly this token and nothing else: CLAUDE_T2", wait: false });
  const w = await call("agent_bridge_wait", { session_ids: [id], mode: "all", timeout_ms: 120000 }, 140000);
  const got2 = (w.results || []).find(x => x.sessionId === id);
  check("turn 2 reuse (wait all)", (got2?.text || "").includes("CLAUDE_T2"), (got2?.text || "").slice(0, 50));
  await call("agent_bridge_close_session", {});
} catch (e) { check(`harness error: ${e.message}`, false); }
finally { srv.stdin.end(); await sleep(800); if (!exited) srv.kill(); await sleep(300); check("server clean shutdown", exited?.code === 0, JSON.stringify(exited)); console.log(`\n>>> ${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`); process.exit(fail === 0 ? 0 : 1); }
