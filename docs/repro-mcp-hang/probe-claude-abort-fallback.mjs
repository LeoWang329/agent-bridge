// Deterministic hermetic test for the claude backend's ABORT FALLBACK + stale-result-swallow path.
// Uses fake-claude.mjs (via CLAUDE_BIN) — no real model, no PATH dependency.
//
// Scenario:
//   Turn A is sent. fake-claude emits an assistant event but WITHHOLDS its result. abort() sends
//   an interrupt control_request; fake-claude acks it but still never emits the result. The bridge
//   waits 5s for turn.promise (withTimeout), times out, and force-settles: pendingAbortedResults=1,
//   status="idle". Turn B is then sent. fake-claude flushes A's stale result FIRST (error_during_
//   execution), then B's assistant + success result. Bridge #handleResult swallows the stale result
//   (pendingAbortedResults counter) and settles B with FAKE_CLAUDE_B_OK. Session stays idle, no wedge.
//
// Expected runtime: ~7-9s (dominated by the 5s abort fallback timeout).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const BRIDGE = path.resolve(HERE, "../../scripts/agent-bridge.mjs");
// Platform shim: .cmd on Windows (routes through cmd.exe), .sh on POSIX.
const FAKE_CLAUDE = path.join(HERE, process.platform === "win32" ? "fake-claude.cmd" : "fake-claude.sh");

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── bridge process ──────────────────────────────────────────────────────────────────────────────
const srv = spawn("node", [BRIDGE, "mcp"], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  env: { ...process.env, CLAUDE_BIN: FAKE_CLAUDE },
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
srv.stderr.on("data", () => {}); // suppress bridge stderr

let idc = 0;
function rpc(method, params) {
  const id = ++idc;
  srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return id;
}

async function call(name, args, waitMs = 60000) {
  const id = rpc("tools/call", { name, arguments: args });
  const t = Date.now();
  while (Date.now() - t < waitMs) {
    if (got.has(id)) break;
    await sleep(100);
  }
  const o = got.get(id);
  if (!o) throw new Error(`timeout waiting for ${name} (${waitMs}ms)`);
  if (o.error) return { __error: o.error };
  try { return JSON.parse(o.result.content[0].text); } catch { return { __raw: o.result?.content?.[0]?.text }; }
}

// ── result tracking ─────────────────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const check = (label, ok, extra = "") => {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${label}${extra ? " — " + extra : ""}`);
  ok ? pass++ : fail++;
};

// ── test body ───────────────────────────────────────────────────────────────────────────────────
try {
  rpc("initialize", { protocolVersion: "2025-06-18" });
  await sleep(300);

  // 1. Open a claude session (fake-claude is spawned; no startup handshake — bridge sets idle immediately).
  const o = await call("agent_bridge_open_session", { agent: "claude", cwd: REPO, write: false });
  check("open session -> idle", o.session?.agent === "claude" && o.session?.status === "idle", o.session?.status);
  const id = o.session?.id;
  if (!id) throw new Error("open_session returned no session id");

  // 2. Send turn A (non-blocking). fake-claude emits an assistant event but withholds the result.
  await call("agent_bridge_send_message", { session_id: id, message: "turn A please run long", wait: false });
  await sleep(800); // give fake-claude time to write the assistant event and the bridge time to process it

  // 3. Abort — bridge sends interrupt; fake-claude acks the control_request immediately. Then the
  //    bridge waits 5s for turn.promise (which never resolves, because fake-claude never emits A's
  //    result). After the 5s withTimeout fires, abort() force-settles: pendingAbortedResults=1, idle.
  console.log("[info] calling abort — expect ~5s fallback wait ...");
  const ab = await call("agent_bridge_abort", { session_id: id }, 30000);
  check("abort returned aborted:true", ab.aborted === true, JSON.stringify(ab).slice(0, 80));

  // 4. Session must be idle (force-settled by the fallback; must be reusable).
  const st = await call("agent_bridge_status", { session_id: id });
  check("status idle after abort fallback (reusable)", st.session?.status === "idle", st.session?.status);

  // 5. Send turn B (non-blocking). fake-claude now receives its 2nd user message:
  //    first flushes A's stale error_during_execution result, then emits B's assistant + success result.
  await call("agent_bridge_send_message", { session_id: id, message: "turn B", wait: false });

  // 6. Wait for turn B to settle. The bridge must swallow A's stale result (pendingAbortedResults
  //    counter) and settle B with its OWN result: FAKE_CLAUDE_B_OK.
  const wr = await call("agent_bridge_wait", { session_ids: [id], mode: "all", timeout_ms: 30000 }, 45000);
  const r0 = wr?.results?.[0];

  check(
    "wait returned results array (not a timeout)",
    !wr?.timedOut && Array.isArray(wr?.results) && wr.results.length > 0,
    JSON.stringify({ timedOut: wr?.timedOut, count: wr?.results?.length }),
  );
  check(
    "turn B settled with FAKE_CLAUDE_B_OK (stale A result was swallowed)",
    (r0?.text || "").includes("FAKE_CLAUDE_B_OK"),
    JSON.stringify((r0?.text || "").slice(0, 120)),
  );
  check(
    "turn B session idle after wait (no wedge)",
    r0?.status === "idle",
    r0?.status,
  );

  // 7. Guard: B's text must not carry an aborted/error_during_execution marker — that would mean the
  //    stale result was NOT swallowed and was instead used to settle B (the exact failure mode we test).
  const bText = r0?.text || "";
  check(
    "turn B text is NOT the stale error marker (swallow counter worked)",
    !bText.includes("error_during_execution") && !bText.includes("claude turn "),
    bText.slice(0, 120),
  );

  // 7b. contextUsage must be null after B. contextUsage now derives from per-call assistant usage, and
  //     neither A's nor B's assistant message carries usage; #beginTurn also resets it each turn. So the
  //     swallowed A result (500k modelUsage) is doubly irrelevant — contextUsage no longer reads modelUsage
  //     at all, and B streamed no assistant usage → null.
  check(
    "contextUsage null after B — no assistant usage streamed; swallowed A's aggregate is not a source",
    r0?.contextUsage == null,
    JSON.stringify(r0?.contextUsage),
  );

  // 8. Clean up.
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
