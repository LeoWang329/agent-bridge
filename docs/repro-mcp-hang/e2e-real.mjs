// END-TO-END test against REAL omp + codex backends (NOT the fake-omp stub the repro-*.mjs use).
// Drives the working-tree MCP server over real JSON-RPC stdio and exercises the full delegated-session
// surface — the paths the pluggable-backends refactor touched: registry dispatch (open omp AND codex),
// isSettled()/refreshStatus() via parallel wait(all)/wait(any), session reuse, status() refresh on both
// backend types, abort + settle-after-abort, async result(), write:true file edit, assertAgent input
// rejection, and clean shutdown. Prints PASS/FAIL per scenario.
//
// ⚠ Spends REAL model tokens and requires BOTH `omp` and `codex` launchable on PATH (override with
// OMP_BIN / CODEX_BIN). If either backend is missing, the suite SKIPs cleanly (exit 0) rather than
// failing. Run manually:  node docs/repro-mcp-hang/e2e-real.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(HERE, "../../scripts/agent-bridge.mjs");
const REPO = path.resolve(HERE, "../..");
const sleep = ms => new Promise(r => setTimeout(r, ms));

const srv = spawn("node", [BRIDGE, "mcp"], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
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
async function call(name, args, waitMs = 200000) {
  const id = rpc("tools/call", { name, arguments: args });
  const t = Date.now();
  while (Date.now() - t < waitMs) { if (got.has(id)) break; await sleep(120); }
  const o = got.get(id);
  if (!o) throw new Error(`timeout waiting for ${name}`);
  if (o.error) return { __error: o.error };
  const txt = o.result?.content?.[0]?.text ?? "";
  try { return JSON.parse(txt); } catch { return { __raw: txt }; }
}

let pass = 0, fail = 0;
const check = (label, ok, extra = "") => { console.log(`[${ok ? "PASS" : "FAIL"}] ${label}${extra ? " — " + extra : ""}`); ok ? pass++ : fail++; };

async function shutdown() {
  srv.stdin.end();
  await sleep(800);
  if (!exited) srv.kill();
  await sleep(300);
}

try {
  rpc("initialize", { protocolVersion: "2025-06-18" });
  await sleep(300);

  // 0. doctor — both real backends present (else SKIP the whole suite, exit 0)
  const doc = await call("agent_bridge_doctor", {});
  const docText = doc.__raw || JSON.stringify(doc);
  const ompOk = /omp:\s*ok/i.test(docText);
  const cdxOk = /codex:\s*ok/i.test(docText);
  const claudeOk = /claude:\s*ok/i.test(docText);
  console.log(`[info] claude backend: ${claudeOk ? "ok" : "absent (claude scenarios will be skipped)"}`);
  console.log(`[info] doctor: ${docText.split("\n").filter(l => /ok|missing/.test(l)).join(" | ")}`);
  if (!ompOk || !cdxOk) {
    console.log(`>>> SKIP: real-backend e2e requires BOTH omp and codex (omp=${ompOk ? "ok" : "missing"}, codex=${cdxOk ? "ok" : "missing"}).`);
    await shutdown();
    process.exit(0);
  }
  check("doctor reports omp + codex ok", ompOk && cdxOk);

  // 1. registry dispatch — open BOTH backends
  const oOmp = await call("agent_bridge_open_session", { agent: "omp", cwd: REPO, write: false });
  const oCdx = await call("agent_bridge_open_session", { agent: "codex", cwd: REPO, write: false });
  const ompId = oOmp.session?.id, cdxId = oCdx.session?.id;
  check("open omp (registry dispatch)", oOmp.session?.agent === "omp" && !!ompId, ompId);
  check("open codex (registry dispatch)", oCdx.session?.agent === "codex" && !!cdxId, cdxId);

  // 2. parallel non-blocking send + wait(mode:all) — isSettled()/refreshStatus() across BOTH types
  await call("agent_bridge_send_message", { session_id: ompId, message: "Reply with exactly: E2E_OMP_1", wait: false });
  await call("agent_bridge_send_message", { session_id: cdxId, message: "Reply with exactly: E2E_CDX_1", wait: false });
  const waitAll = await call("agent_bridge_wait", { session_ids: [ompId, cdxId], mode: "all", timeout_ms: 180000 }, 200000);
  const byId = Object.fromEntries((waitAll.results || []).map(r => [r.sessionId, r]));
  check("wait(all) settled omp (isSettled/refresh)", (byId[ompId]?.text || "").includes("E2E_OMP_1"), (byId[ompId]?.text || "").slice(0, 40));
  check("wait(all) settled codex (isSettled/refresh)", (byId[cdxId]?.text || "").includes("E2E_CDX_1"), (byId[cdxId]?.text || "").slice(0, 40));

  // 2b. contextUsage — current-context occupancy normalized across backends from the REAL usage payloads
  // (omp get_state.contextUsage → live:true; codex thread/tokenUsage/updated → live:false). tokens and
  // contextWindow must be positive; this is the signal an orchestrator watches to reopen before rot.
  const cuOmp = byId[ompId]?.contextUsage;
  const cuCdx = byId[cdxId]?.contextUsage;
  check("omp contextUsage present + live (real get_state)", !!cuOmp && cuOmp.tokens > 0 && cuOmp.contextWindow > 0 && cuOmp.live === true, JSON.stringify(cuOmp));
  check("codex contextUsage present + snapshot (real tokenUsage)", !!cuCdx && cuCdx.tokens > 0 && cuCdx.contextWindow > 0 && cuCdx.live === false, JSON.stringify(cuCdx));

  // 3. session reuse — 2nd turn on the SAME omp session, inline wait:true (async result path)
  const reuse = await call("agent_bridge_send_message", { session_id: ompId, message: "Reply with exactly: E2E_OMP_2", wait: true, timeout_ms: 120000 }, 140000);
  check("session reuse (omp 2nd turn, async result)", (reuse.text || "").includes("E2E_OMP_2"), (reuse.text || "").slice(0, 40));

  // 4. status() refresh on both backend types (omp polls via refreshStatus; codex no-op)
  const stOmp = await call("agent_bridge_status", { session_id: ompId });
  const stCdx = await call("agent_bridge_status", { session_id: cdxId });
  check("status(omp) idle after turn (refreshStatus poll)", stOmp.session?.status === "idle", stOmp.session?.status);
  check("status(codex) idle (refreshStatus no-op)", stCdx.session?.status === "idle", stCdx.session?.status);
  // T4/P1: codex writes "failed to refresh available models" (and other progress) to stderr on startup.
  // After a CLEAN turn that must NOT be in lastError anymore — it belongs in lastStderr (diagnostics).
  check("codex benign stderr NOT in lastError (T4)", stCdx.session?.lastError === null, `lastError=${JSON.stringify(stCdx.session?.lastError)} lastStderr=${JSON.stringify((stCdx.session?.lastStderr || "").slice(0, 60))}`);

  // 4b. T11 (A1): Codex-native structured output. Ask for a small object and enforce it with a schema;
  // the result must carry a PARSED top-level `json` (schemaError null). Real server-side outputSchema.
  const SCHEMA = { type: "object", properties: { verdict: { type: "string" }, count: { type: "number" } }, required: ["verdict", "count"], additionalProperties: false };
  await call("agent_bridge_send_message", { session_id: cdxId, message: 'Return a JSON object with verdict="ok" and count=3.', schema: SCHEMA, wait: false });
  const schemaWait = await call("agent_bridge_wait", { session_ids: [cdxId], mode: "all", timeout_ms: 180000 }, 200000);
  const schemaRes = schemaWait.results?.[0];
  check("codex schema → parsed json (T11)", !!schemaRes?.json && typeof schemaRes.json === "object" && schemaRes.schemaError == null, `json=${JSON.stringify(schemaRes?.json)} schemaError=${JSON.stringify(schemaRes?.schemaError)}`);

  // 5. wait(mode:any) — send to both, return on first; then drain the rest
  await call("agent_bridge_send_message", { session_id: ompId, message: "Reply with exactly: E2E_ANY_OMP", wait: false });
  await call("agent_bridge_send_message", { session_id: cdxId, message: "Reply with exactly: E2E_ANY_CDX", wait: false });
  const anyR = await call("agent_bridge_wait", { session_ids: [ompId, cdxId], mode: "any", timeout_ms: 180000 }, 200000);
  const firstDone = anyR.completed?.sessionId || anyR.completed || (anyR.results || [])[0]?.sessionId;
  check("wait(any) returns a completed id", !!firstDone, JSON.stringify({ completed: anyR.completed }).slice(0, 70));
  const pend = anyR.pending || [ompId, cdxId].filter(x => x !== firstDone);
  if (pend && pend.length) await call("agent_bridge_wait", { session_ids: pend, mode: "all", timeout_ms: 180000 }, 200000);

  // 6. abort — start a longer codex turn non-blocking, abort it, confirm it settles to idle
  await call("agent_bridge_send_message", { session_id: cdxId, message: "Count slowly from 1 to 500, one number per line.", wait: false });
  await sleep(1500);
  const ab = await call("agent_bridge_abort", { session_id: cdxId });
  check("abort accepted", ab.aborted === true || !ab.__error, JSON.stringify(ab).slice(0, 60));
  await sleep(1500);
  const stAfterAbort = await call("agent_bridge_status", { session_id: cdxId });
  check("codex settles to idle after abort (isSettled)", stAfterAbort.session?.status === "idle", stAfterAbort.session?.status);

  // 7. write:true — open an omp session in a fresh TEMP dir, have it create a file, verify, clean up.
  // Temp dir (never the repo) keeps this safe + reversible regardless of outcome.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ab-e2e-write-"));
  let wId = null;
  try {
    const oW = await call("agent_bridge_open_session", { agent: "omp", cwd: tmp, write: true });
    wId = oW.session?.id;
    check("open omp write:true (temp dir)", oW.session?.write === true && !!wId, wId);
    await call("agent_bridge_send_message", { session_id: wId, message: "Create a file named e2e_write.txt whose entire contents are exactly the line: E2E_WRITE_OK — then reply DONE.", wait: true, timeout_ms: 150000 }, 170000);
    const target = path.join(tmp, "e2e_write.txt");
    const wrote = fs.existsSync(target) && fs.readFileSync(target, "utf8").includes("E2E_WRITE_OK");
    check("write:true actually edited a file on disk", wrote, wrote ? fs.readFileSync(target, "utf8").trim().slice(0, 40) : "file not created");
  } finally {
    // Close in the finally — NOT the happy path — so a thrown/timed-out send still SIGTERMs the omp
    // child; otherwise the cleanup below would race a still-live session and always leak. close()
    // returns the moment it SIGTERMs the backend; the omp child (cwd == tmp) dies asynchronously.
    if (wId) { try { await call("agent_bridge_close_session", { session_id: wId }); } catch {} }
    // On Windows a directory with a live process's open handle can't be removed, and worse: deleting
    // it while that handle is open leaves it "delete-pending", a state fs.rm's OWN `maxRetries` (a
    // synchronous spin) never recovers from — the holding condition is the omp child's handle, which
    // only the child's exit releases. So poll-and-retry from the OUTSIDE: a FRESH rmSync after a real
    // async sleep, landing cleanly once the child has exited (~0.5–1s). POSIX never hit this.
    let lastErr = null;
    for (let i = 0; i < 40 && fs.existsSync(tmp); i++) {
      try { fs.rmSync(tmp, { recursive: true, force: true }); break; }
      catch (e) { lastErr = e; await sleep(250); }
    }
    // Assert the cleanup actually succeeded — without this, an exhausted retry budget would leak the
    // temp dir while the suite still reported PASS (silent leak). Surface the real errno to debug.
    check("step 7 temp dir cleaned up", !fs.existsSync(tmp), fs.existsSync(tmp) ? `LEAKED ${tmp} (${lastErr?.code || lastErr?.message || "unknown"})` : "");
  }

  // 8. unknown agent rejected (assertAgent hardening) over the REAL server
  const bad = await call("agent_bridge_open_session", { agent: "ompp", cwd: REPO, write: false });
  check("unknown agent rejected cleanly", !!bad.__error && /Unsupported agent/.test(bad.__error.message), bad.__error?.message?.slice(0, 50));

  // 8b. claude backend (only when present) — dispatch, a turn, write:true edit, abort+settle.
  if (claudeOk) {
    const oCl = await call("agent_bridge_open_session", { agent: "claude", cwd: REPO, write: false });
    const clId = oCl.session?.id;
    check("open claude (registry dispatch)", oCl.session?.agent === "claude" && !!clId, clId);
    const clTurn = await call("agent_bridge_send_message", { session_id: clId, message: "Reply with exactly: E2E_CLAUDE_1", wait: true, timeout_ms: 120000 }, 140000);
    check("claude turn (async result)", (clTurn.text || "").includes("E2E_CLAUDE_1"), (clTurn.text || "").slice(0, 40));
    // contextUsage from real modelUsage (last-turn snapshot; primary = largest-window model entry).
    check("claude contextUsage present + snapshot (real modelUsage)", !!clTurn.contextUsage && clTurn.contextUsage.tokens > 0 && clTurn.contextUsage.contextWindow > 0 && clTurn.contextUsage.live === false, JSON.stringify(clTurn.contextUsage));

    // abort: long turn non-blocking, abort, confirm idle + reusable
    await call("agent_bridge_send_message", { session_id: clId, message: "Count slowly from 1 to 400, one number per line.", wait: false });
    await sleep(2500);
    const clAb = await call("agent_bridge_abort", { session_id: clId });
    check("claude abort accepted", clAb.aborted === true, JSON.stringify(clAb).slice(0, 50));
    await sleep(1500);
    const clSt = await call("agent_bridge_status", { session_id: clId });
    check("claude settles to idle after abort", clSt.session?.status === "idle", clSt.session?.status);
    await call("agent_bridge_close_session", { session_id: clId });

    // write:true — fresh temp dir, create a file, verify on disk, clean up (mirrors step 7).
    const ctmp = fs.mkdtempSync(path.join(os.tmpdir(), "ab-e2e-claude-write-"));
    let cwId = null;
    try {
      const oCW = await call("agent_bridge_open_session", { agent: "claude", cwd: ctmp, write: true });
      cwId = oCW.session?.id;
      check("open claude write:true (temp dir)", oCW.session?.write === true && !!cwId, cwId);
      await call("agent_bridge_send_message", { session_id: cwId, message: "Create a file named e2e_claude.txt whose entire contents are exactly the line: E2E_CLAUDE_WRITE_OK — then reply DONE.", wait: true, timeout_ms: 150000 }, 170000);
      const ctarget = path.join(ctmp, "e2e_claude.txt");
      const cwrote = fs.existsSync(ctarget) && fs.readFileSync(ctarget, "utf8").includes("E2E_CLAUDE_WRITE_OK");
      check("claude write:true edited a file on disk", cwrote, cwrote ? "ok" : "file not created");
    } finally {
      if (cwId) { try { await call("agent_bridge_close_session", { session_id: cwId }); } catch {} }
      let cErr = null;
      for (let i = 0; i < 40 && fs.existsSync(ctmp); i++) { try { fs.rmSync(ctmp, { recursive: true, force: true }); break; } catch (e) { cErr = e; await sleep(250); } }
      check("claude temp dir cleaned up", !fs.existsSync(ctmp), fs.existsSync(ctmp) ? `LEAKED ${ctmp} (${cErr?.code || "unknown"})` : "");
    }
  }

  // 9. close all remaining + clean exit
  const closed = await call("agent_bridge_close_session", {});
  check("close all sessions", closed.closedAll === true || closed.count >= 2, JSON.stringify({ count: closed.count }));
} catch (err) {
  check(`harness error: ${err.message}`, false);
} finally {
  await shutdown();
  check("server clean shutdown (code 0)", exited?.code === 0, JSON.stringify(exited));
  console.log("");
  console.log(`>>> ${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed (real-backend e2e)`);
  process.exit(fail === 0 ? 0 : 1);
}
