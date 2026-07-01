// Hermetic (no real claude needed): a bad CLAUDE_BIN must make open_session FAIL cleanly — return an
// error, NOT a healthy-looking "idle" session that dies a tick later. Proves start() awaits the OS
// spawn result (spawn/error race) instead of advertising a dead process as ready.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const BRIDGE = path.resolve(HERE, "../../scripts/agent-bridge.mjs");
// Absolute, nonexistent .exe -> spawn emits ENOENT 'error' (native exe path, no cmd.exe routing).
const BAD_BIN = path.join(HERE, "no-such-claude-binary-xyz.exe");

const sleep = ms => new Promise(r => setTimeout(r, ms));
const srv = spawn("node", [BRIDGE, "mcp"], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  env: { ...process.env, CLAUDE_BIN: BAD_BIN },
});
let exited = null;
srv.on("close", (code, signal) => { exited = { code, signal }; });

let buf = "";
const got = new Map();
srv.stdout.on("data", d => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const l = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (l) { try { const o = JSON.parse(l); if (o.id !== undefined) got.set(o.id, o); } catch {} }
  }
});
srv.stderr.on("data", () => {});

let idc = 0;
function rpc(method, params) {
  const id = ++idc;
  srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return id;
}
async function call(name, args, waitMs = 30000) {
  const id = rpc("tools/call", { name, arguments: args });
  const t = Date.now();
  while (Date.now() - t < waitMs) { if (got.has(id)) break; await sleep(100); }
  const o = got.get(id);
  if (!o) throw new Error(`timeout waiting for ${name}`);
  if (o.error) return { __error: o.error };
  try { return JSON.parse(o.result.content[0].text); } catch { return { __raw: o.result?.content?.[0]?.text }; }
}

let pass = 0, fail = 0;
const check = (label, ok, extra = "") => { console.log(`[${ok ? "PASS" : "FAIL"}] ${label}${extra ? " — " + extra : ""}`); ok ? pass++ : fail++; };

try {
  rpc("initialize", { protocolVersion: "2025-06-18" });
  await sleep(300);
  const o = await call("agent_bridge_open_session", { agent: "claude", cwd: REPO, write: false });
  // A dead binary must NOT yield an idle session. The bridge should surface an error (or, defensively,
  // a non-idle/failed session) rather than a usable-looking one.
  const notIdle = o.session?.status !== "idle";
  const erroredCleanly = !!o.__error || o.session?.status === "failed" || (o.session == null);
  check("bad CLAUDE_BIN -> open_session did NOT return an idle session", notIdle, JSON.stringify(o).slice(0, 160));
  check("bad CLAUDE_BIN -> open_session failed cleanly (error surfaced)", erroredCleanly, JSON.stringify(o).slice(0, 160));
} catch (e) {
  check(`harness error: ${e.message}`, false);
} finally {
  srv.stdin.end();
  await sleep(600);
  if (!exited) srv.kill();
  await sleep(300);
  check("server clean shutdown (exit 0)", exited?.code === 0, JSON.stringify(exited));
  console.log(`\n>>> ${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
