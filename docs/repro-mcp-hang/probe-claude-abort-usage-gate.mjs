// Deterministic hermetic test for the claude backend's contextUsage GATE across an abort.
// Uses fake-claude.mjs mode "abortusage" (via CLAUDE_BIN + FAKE_CLAUDE_MODE) — no real model.
//
// Why this exists: contextUsage is sourced from per-call assistant usage captured in #handleLine. That
// capture is GATED (only from a live, kept, non-aborting turn) exactly like the result-usage swallow so a
// force-settled abort's late assistant can't leak into a later turn. This test drives that leak path:
//   Turn A's assistant carries usage (77000); A is aborted (force-settled, pendingAbortedResults=1).
//   Turn B: a LATE turn-A assistant carrying usage (99000) is flushed while pending>0 (must be SKIPPED by
//   the gate), then A's stale result is swallowed, then B's assistant (NO usage) + success result.
//   Expected: contextUsage null after B — A's 77000 was reset at #beginTurn and the late 99000 was gated
//   out. Without the gate, 99000 would leak as B's contextUsage.
//
// Expected runtime: ~7-9s (dominated by the 5s abort fallback timeout).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const BRIDGE = path.resolve(HERE, "../../scripts/agent-bridge.mjs");
const FAKE_CLAUDE = path.join(HERE, process.platform === "win32" ? "fake-claude.cmd" : "fake-claude.sh");

const sleep = ms => new Promise(r => setTimeout(r, ms));

const srv = spawn("node", [BRIDGE, "mcp"], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  env: { ...process.env, CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_MODE: "abortusage" },
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
async function call(name, args, waitMs = 60000) {
  const id = rpc("tools/call", { name, arguments: args });
  const t = Date.now();
  while (Date.now() - t < waitMs) { if (got.has(id)) break; await sleep(100); }
  const o = got.get(id);
  if (!o) throw new Error(`timeout waiting for ${name} (${waitMs}ms)`);
  if (o.error) return { __error: o.error };
  try { return JSON.parse(o.result.content[0].text); } catch { return { __raw: o.result?.content?.[0]?.text }; }
}

let pass = 0, fail = 0;
const check = (label, ok, extra = "") => { console.log(`[${ok ? "PASS" : "FAIL"}] ${label}${extra ? " — " + extra : ""}`); ok ? pass++ : fail++; };

try {
  rpc("initialize", { protocolVersion: "2025-06-18" });
  await sleep(300);

  const o = await call("agent_bridge_open_session", { agent: "claude", cwd: REPO, write: false });
  check("open session -> idle", o.session?.agent === "claude" && o.session?.status === "idle", o.session?.status);
  const id = o.session?.id;
  if (!id) throw new Error("open_session returned no session id");

  // Turn A: assistant carries usage (77000), result withheld.
  await call("agent_bridge_send_message", { session_id: id, message: "turn A please run long", wait: false });
  await sleep(800);

  console.log("[info] calling abort — expect ~5s fallback wait ...");
  const ab = await call("agent_bridge_abort", { session_id: id }, 30000);
  check("abort returned aborted:true", ab.aborted === true, JSON.stringify(ab).slice(0, 80));

  const st = await call("agent_bridge_status", { session_id: id });
  check("status idle after abort fallback (reusable)", st.session?.status === "idle", st.session?.status);

  // Turn B: late A-assistant with usage (99000) while pending>0, then stale A result, then B (no usage).
  await call("agent_bridge_send_message", { session_id: id, message: "turn B", wait: false });
  const wr = await call("agent_bridge_wait", { session_ids: [id], mode: "all", timeout_ms: 30000 }, 45000);
  const r0 = wr?.results?.[0];

  check("turn B settled with FAKE_CLAUDE_B_OK (stale A result swallowed)", (r0?.text || "").includes("FAKE_CLAUDE_B_OK"), JSON.stringify((r0?.text || "").slice(0, 120)));
  check("turn B session idle after wait", r0?.status === "idle", r0?.status);

  // THE GATE ASSERTION: contextUsage null after B. A's 77000 reset at #beginTurn; the late 99000 arrived
  // while pendingAbortedResults>0 and was skipped by the #handleLine gate; B streamed no usage → null.
  // Without the gate, 99000 would leak here.
  check(
    "contextUsage null after B — aborted turn's late assistant usage (99000) gated out, 77000 reset",
    r0?.contextUsage == null,
    JSON.stringify(r0?.contextUsage),
  );

  await call("agent_bridge_close_session", { session_id: id });
} catch (e) {
  check(`harness error: ${e.message}`, false);
} finally {
  srv.stdin.end();
  await sleep(800);
  if (!exited) srv.kill();
  await sleep(300);
  check("server clean shutdown (exit 0)", exited?.code === 0, JSON.stringify(exited));
  console.log(`\n>>> ${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
